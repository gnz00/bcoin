/*!
 * workerpool.js - worker processes for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var util = require('../utils/util');
var co = require('../utils/co');
var global = util.global;
var Network = require('../protocol/network');
var jobs = require('./jobs');
var Parser = require('./parser');
var Framer = require('./framer');
var packets = require('./packets');
var os = require('os');
var cp = require('child_process');

/**
 * A worker pool.
 * @exports WorkerPool
 * @constructor
 * @param {Object} options
 * @param {Number} [options.size=num-cores] - Max pool size.
 * @param {Number} [options.timeout=10000] - Execution timeout.
 * @property {Number} size
 * @property {Number} timeout
 * @property {Object} children
 * @property {Number} nonce
 */

function WorkerPool(options) {
  if (!(this instanceof WorkerPool))
    return new WorkerPool(options);

  EventEmitter.call(this);

  if (!options)
    options = {};

  this.size = Math.max(1, options.size || WorkerPool.CORES);
  this.timeout = options.timeout || 60000;
  this.children = [];
  this.nonce = 0;
  this.enabled = true;
}

util.inherits(WorkerPool, EventEmitter);

/**
 * Whether workers are supported.
 * @const {Boolean}
 */

WorkerPool.support = true;

if (util.isBrowser) {
  WorkerPool.support = typeof global.Worker === 'function'
    || typeof global.postMessage === 'function';
}

/**
 * Number of CPUs/cores available.
 * @const {Number}
 */

WorkerPool.CORES = getCores();

/**
 * Global list of workers.
 * @type {Array}
 */

WorkerPool.children = [];

/**
 * Destroy all workers.
 * Used for cleaning up workers on exit.
 * @private
 */

WorkerPool.cleanup = function cleanup() {
  while (WorkerPool.children.length > 0)
    WorkerPool.children.pop().destroy();
};

WorkerPool._exitBound = false;

/**
 * Bind to process events in order to cleanup listeners.
 * @private
 */

WorkerPool._bindExit = function _bindExit() {
  if (util.isBrowser)
    return;

  if (WorkerPool._exitBound)
    return;

  WorkerPool._exitBound = true;

  function onExit(err) {
    WorkerPool.cleanup();

    if (err) {
      util.error(err.stack + '');
      process.exit(1);
      return;
    }

    process.exit(0);
  }

  process.once('exit', function() {
    WorkerPool.cleanup();
  });

  if (process.listeners('SIGINT').length === 0)
    process.once('SIGINT', onExit);

  if (process.listeners('SIGTERM').length === 0)
    process.once('SIGTERM', onExit);

  if (process.listeners('uncaughtException').length === 0)
    process.once('uncaughtException', onExit);

  process.on('newListener', function(name) {
    if (name === 'SIGINT'
        || name === 'SIGTERM'
        || name === 'uncaughtException') {
      process.removeListener(name, onExit);
    }
  });
};

/**
 * Spawn a new worker.
 * @param {Number} id - Worker ID.
 * @returns {Worker}
 */

WorkerPool.prototype.spawn = function spawn(id) {
  var self = this;
  var child;

  child = new Worker(id);

  child.on('error', function(err) {
    self.emit('error', err, child);
  });

  child.on('exit', function(code) {
    self.emit('exit', code, child);
    if (self.children[child.id] === child)
      self.children[child.id] = null;
  });

  child.on('event', function(items) {
    self.emit('event', items, child);
    self.emit.apply(self, items);
  });

  this.emit('spawn', child);

  return child;
};

/**
 * Allocate a new worker, will not go above `size` option
 * and will automatically load balance the workers.
 * @returns {Worker}
 */

WorkerPool.prototype.alloc = function alloc() {
  var id = this.nonce++ % this.size;
  if (!this.children[id])
    this.children[id] = this.spawn(id);
  return this.children[id];
};

/**
 * Emit an event on the worker side (all workers).
 * @param {String} event
 * @param {...Object} arg
 * @returns {Boolean}
 */

WorkerPool.prototype.sendEvent = function sendEvent() {
  var i, child;
  var result = true;

  for (i = 0; i < this.children.length; i++) {
    child = this.children[i];

    if (!child)
      continue;

    if (!child.sendEvent.apply(child, arguments))
      result = false;
  }

  return result;
};

/**
 * Destroy all workers.
 */

WorkerPool.prototype.destroy = function destroy() {
  var i, child;

  for (i = 0; i < this.children.length; i++) {
    child = this.children[i];

    if (!child)
      continue;

    child.destroy();
  }
};

/**
 * Call a method for a worker to execute.
 * @param {Packet} packet
 * @param {Number} timeout
 * @returns {Promise}
 * the worker method specifies.
 */

WorkerPool.prototype.execute = function execute(packet, timeout) {
  var result, child;

  if (!this.enabled || !WorkerPool.support) {
    return new Promise(function(resolve, reject) {
      util.nextTick(function() {
        try {
          result = jobs._execute(packet);
        } catch (e) {
          reject(e);
          return;
        }
        resolve(result);
      });
    });
  }

  if (!timeout)
    timeout = this.timeout;

  child = this.alloc();

  return child.execute(packet, timeout);
};

/**
 * Execute the tx verification job (default timeout).
 * @param {TX} tx
 * @param {VerifyFlags} flags
 * @returns {Promise} - Returns Boolean.
 */

WorkerPool.prototype.verify = co(function* verify(tx, flags) {
  var packet = new packets.VerifyPacket(tx, flags);
  var result = yield this.execute(packet, -1);
  return result.value;
});

/**
 * Execute the tx signing job (default timeout).
 * @param {MTX} tx
 * @param {KeyRing[]} ring
 * @param {SighashType} type
 * @returns {Promise}
 */

WorkerPool.prototype.sign = co(function* sign(tx, ring, type) {
  var rings = ring;
  var packet, result;

  if (!Array.isArray(rings))
    rings = [rings];

  packet = new packets.SignPacket(tx, rings, type);
  result = yield this.execute(packet, -1);

  result.inject(tx);

  return result.total;
});

/**
 * Execute the tx input verification job (default timeout).
 * @param {TX} tx
 * @param {Number} index
 * @param {VerifyFlags} flags
 * @returns {Promise} - Returns Boolean.
 */

WorkerPool.prototype.verifyInput = co(function* verifyInput(tx, index, flags) {
  var packet = new packets.VerifyInputPacket(tx, index, flags);
  var result = yield this.execute(packet, -1);
  return result.value;
});

/**
 * Execute the tx input signing job (default timeout).
 * @param {MTX} tx
 * @param {Number} index
 * @param {KeyRing} ring
 * @param {SighashType} type
 * @returns {Promise}
 */

WorkerPool.prototype.signInput = co(function* signInput(tx, index, ring, type) {
  var rings = ring;
  var packet, result;

  if (!Array.isArray(rings))
    rings = [rings];

  packet = new packets.SignInputPacket(tx, index, rings, type);
  result = yield this.execute(packet, -1);

  result.inject(tx);

  return result.value;
});

/**
 * Execute the ec verify job (no timeout).
 * @param {Buffer} msg
 * @param {Buffer} sig - DER formatted.
 * @param {Buffer} key
 * @returns {Promise}
 */

WorkerPool.prototype.ecVerify = co(function* ecVerify(msg, sig, key) {
  var packet = new packets.ECVerifyPacket(msg, sig, key);
  var result = yield this.execute(packet, -1);
  return result.value;
});

/**
 * Execute the ec signing job (no timeout).
 * @param {Buffer} msg
 * @param {Buffer} key
 * @returns {Promise}
 */

WorkerPool.prototype.ecSign = co(function* ecSign(msg, key) {
  var packet = new packets.SignPacket(msg, key);
  var result = yield this.execute(packet, -1);
  return result.sig;
});

/**
 * Execute the mining job (no timeout).
 * @param {Buffer} data
 * @param {Buffer} target
 * @param {Number} min
 * @param {Number} max
 * @returns {Promise} - Returns {Number}.
 */

WorkerPool.prototype.mine = co(function* mine(data, target, min, max) {
  var packet = new packets.MinePacket(data, target, min, max);
  var result = yield this.execute(packet, -1);
  return result.nonce;
});

/**
 * Execute scrypt job (no timeout).
 * @param {Buffer} passwd
 * @param {Buffer} salt
 * @param {Number} N
 * @param {Number} r
 * @param {Number} p
 * @param {Number} len
 * @returns {Promise}
 * @returns {Buffer}
 */

WorkerPool.prototype.scrypt = co(function* scrypt(passwd, salt, N, r, p, len) {
  var packet = new packets.ScryptPacket(passwd, salt, N, r, p, len);
  var result = yield this.execute(packet, -1);
  return result.key;
});

/**
 * Represents a worker.
 * @exports Worker
 * @constructor
 * @param {Number?} id
 */

function Worker(id) {
  if (!(this instanceof Worker))
    return new Worker(id);

  EventEmitter.call(this);

  this.framer = new Framer();
  this.parser = new Parser();
  this.setMaxListeners(util.MAX_SAFE_INTEGER);
  this.id = id != null ? id : -1;
  this.child = null;
  this.pending = {};

  this._init();
}

util.inherits(Worker, EventEmitter);

/**
 * Initialize worker. Bind to events.
 * @private
 */

Worker.prototype._init = function _init() {
  var self = this;
  var penv;

  penv = {
    BCOIN_WORKER_NETWORK: Network.type
  };

  if (util.isBrowser) {
    this.child = new global.Worker('/bcoin-worker.js');

    this.child.onerror = function onerror(err) {
      self.emit('error', err);
      self.emit('exit', -1, null);
    };

    this.child.onmessage = function onmessage(event) {
      var data;
      if (typeof event.data !== 'string') {
        data = event.data.buf;
        data.__proto__ = Buffer.prototype;
      } else {
        data = new Buffer(event.data, 'hex');
      }
      self.emit('data', data);
    };

    this.child.postMessage(JSON.stringify(penv));
  } else {
    this.child = cp.spawn(process.argv[0], [__dirname + '/worker.js'], {
      stdio: 'pipe',
      env: util.merge({}, process.env, penv)
    });

    this.child.on('error', function(err) {
      self.emit('error', err);
    });

    this.child.on('exit', function(code, signal) {
      self.emit('exit', code == null ? -1 : code, signal);
    });

    this.child.on('close', function() {
      self.emit('exit', -1, null);
    });

    this.child.stdin.on('error', function(err) {
      self.emit('error', err);
    });

    this.child.stdout.on('error', function(err) {
      self.emit('error', err);
    });

    this.child.stderr.on('error', function(err) {
      self.emit('error', err);
    });

    this.child.stdout.on('data', function(data) {
      self.emit('data', data);
    });
  }

  this.on('exit', function() {
    self.killJobs();
  });

  this.on('error', function() {
    self.killJobs();
  });

  this.on('data', function(data) {
    self.parser.feed(data);
  });

  this.parser.on('error', function(e) {
    self.emit('error', e);
  });

  this.parser.on('packet', function(packet) {
    self.emit('packet', packet);
  });

  this._bind();
};

/**
 * Initialize worker. Bind to more events.
 * @private
 */

Worker.prototype._bind = function _bind() {
  var self = this;

  this.on('exit', function(code) {
    var i = WorkerPool.children.indexOf(self);
    if (i !== -1)
      WorkerPool.children.splice(i, 1);
  });

  this.on('packet', function(packet) {
    switch (packet.cmd) {
      case packets.types.EVENT:
        self.emit.apply(self, packet.items);
        self.emit('event', packet.items);
        break;
      case packets.types.LOG:
        util.log('Worker %d:', self.id);
        util.log.apply(util, packet.items);
        break;
      case packets.types.ERROR:
        self.emit('error', packet.error);
        break;
      case packets.types.ERRORRESULT:
        self.rejectJob(packet.id, packet.error);
        break;
      default:
        self.resolveJob(packet.id, packet);
        break;
    }
  });

  WorkerPool.children.push(this);

  WorkerPool._bindExit();
};

/**
 * Send data to worker.
 * @param {Buffer} data
 * @returns {Boolean}
 */

Worker.prototype.write = function write(data) {
  if (util.isBrowser) {
    if (this.child.postMessage.length === 2) {
      data.__proto__ = Uint8Array.prototype;
      this.child.postMessage({ buf: data }, [data]);
    } else {
      this.child.postMessage(data.toString('hex'));
    }
    return true;
  }
  return this.child.stdin.write(data);
};

/**
 * Frame and send a packet.
 * @param {Packet} packet
 * @returns {Boolean}
 */

Worker.prototype.send = function send(packet) {
  return this.write(this.framer.packet(packet));
};

/**
 * Emit an event on the worker side.
 * @param {String} event
 * @param {...Object} arg
 * @returns {Boolean}
 */

Worker.prototype.sendEvent = function sendEvent() {
  var items = new Array(arguments.length);
  var i;

  for (i = 0; i < items.length; i++)
    items[i] = arguments[i];

  return this.send(new packets.EventPacket(items));
};

/**
 * Destroy the worker.
 */

Worker.prototype.destroy = function destroy() {
  if (util.isBrowser) {
    this.child.terminate();
    this.emit('exit', -1, 'SIGTERM');
    return;
  }
  return this.child.kill('SIGTERM');
};

/**
 * Call a method for a worker to execute.
 * @param {Packet} packet
 * @param {Number} timeout
 * @returns {Promise}
 */

Worker.prototype.execute = function execute(packet, timeout) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self._execute(packet, timeout, co.wrap(resolve, reject));
  });
};

/**
 * Call a method for a worker to execute.
 * @private
 * @param {Packet} packet
 * @param {Number} timeout
 * @param {Function} callback
 * the worker method specifies.
 */

Worker.prototype._execute = function _execute(packet, timeout, callback) {
  var job = new PendingJob(this, packet.id, callback);

  assert(!this.pending[packet.id]);

  this.pending[packet.id] = job;

  job.start(timeout);

  this.send(packet);
};

/**
 * Resolve a job.
 * @param {Number} id
 * @param {Packet} result
 */

Worker.prototype.resolveJob = function resolveJob(id, result) {
  var job = this.pending[id];
  assert(job);
  job.finish(null, result);
};

/**
 * Reject a job.
 * @param {Number} id
 * @param {Error} err
 */

Worker.prototype.rejectJob = function rejectJob(id, err) {
  var job = this.pending[id];
  assert(job);
  job.finish(err);
};

/**
 * Kill all jobs associated with worker.
 */

Worker.prototype.killJobs = function killJobs() {
  var keys = Object.keys(this.pending);
  var i, key, job;

  for (i = 0; i < keys.length; i++) {
    key = keys[i];
    job = this.pending[key];
    job.destroy();
  }
};

/**
 * PendingWorker
 * @constructor
 */

function PendingJob(worker, id, callback) {
  this.worker = worker;
  this.id = id;
  this.callback = callback;
  this.timer = null;
}

PendingJob.prototype.start = function start(timeout) {
  var self = this;

  if (timeout === -1)
    return;

  this.timer = setTimeout(function() {
    self.finish(new Error('Worker timed out.'));
  }, timeout);
};

PendingJob.prototype.destroy = function destroy() {
  this.finish(new Error('Job was destroyed.'));
};

PendingJob.prototype.finish = function finish(err, result) {
  var callback = this.callback;

  assert(callback, 'Already finished.');

  this.callback = null;

  if (this.timer != null) {
    clearTimeout(this.timer);
    this.timer = null;
  }

  assert(this.worker.pending[this.id]);
  delete this.worker.pending[this.id];

  callback(err, result);
};

/*
 * Helpers
 */

function getCores() {
  if (os.unsupported)
    return 2;

  return os.cpus().length;
}

/*
 * Default
 */

exports.pool = new WorkerPool();
exports.pool.enabled = false;

exports.set = function set(options) {
  if (typeof options.useWorkers === 'boolean')
    this.pool.enabled = options.useWorkers;

  if (util.isNumber(options.maxWorkers))
    this.pool.size = options.maxWorkers;

  if (util.isNumber(options.workerTimeout))
    this.pool.timeout = options.workerTimeout;
};

exports.set({
  useWorkers: +process.env.BCOIN_USE_WORKERS === 1,
  maxWorkers: +process.env.BCOIN_MAX_WORKERS,
  workerTimeout: +process.env.BCOIN_WORKER_TIMEOUT
});

/*
 * Expose
 */

exports.WorkerPool = WorkerPool;
exports.Worker = Worker;