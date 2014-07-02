var http = require('http');

var PSTATE_WAITING = "waiting";
var PSTATE_READY = "ready";
var PSTATE_RUNNING = "running";

var Processor = function (sys, info) {
	var This = this;
	This._sys = sys;
	This._info = info;
};

Processor.prototype.send = function () {
	var This = this;
	var args = Array.prototype.slice.call(arguments);
	args.unshift(This);
	This._sys._push.apply(This._sys, args);
};

var ProcessorSystem = function () {
	var This = this;
	This._processorTypes = {};
	This._processorInstances = {};
	This._readyQ = [];
	This._msgCount = 0;
};

ProcessorSystem.prototype.registerType = function (def) {
	var This = this;
	This._processorTypes[def.name] = {
		name: def.name,
		fn: def.fn,
		count: 0
	};
	console.log("actor_type " + def.name);
};


ProcessorSystem.prototype.create = function (descr) {
	var This = this;
	var def = This._processorTypes[descr.type];

	def.count = def.count + 1;
	var name = descr.name || (descr.type + def.count);
	var info = {
		type: descr.type,
		name: name,
		state: PSTATE_WAITING,
		msgQ: [],
		currMsg: null
	};
	info.instance = new Processor(This, info);
	This._processorInstances[name] = info;
	console.log("actor " + name + ": " + descr.type);
	return This._processorInstances[name].instance;
};


ProcessorSystem.prototype._serviceReadyQ = function () {
	var This = this;
	var info = This._readyQ.pop();
	var def = This._processorTypes[info.type];

	
	var msg = info.msgQ.pop();
	info.currMsg = msg;
	info.state = PSTATE_RUNNING;
	var cb = function () {
		info.currMsg = null;

		if (info.msgQ.length) {
			info.state = PSTATE_READY;
			This._readyQ.unshift(info);
			This._serviceReadyQ();
		}
		else {
			info.state = PSTATE_WAITING;
		}
	};

	var ctx = {
		message: msg,
		send: info.instance.send.bind(info.instance),
		callback: cb
	};
	setImmediate(def.fn, ctx, cb);
};

ProcessorSystem.prototype._enqueueMessage = function (msg) {
	var This = this;
	var to = msg.to;
	to._info.msgQ.push(msg);
	if (to._info.state === PSTATE_WAITING) {
		This._readyQ.unshift(to._info);
		to._info.state = PSTATE_READY;
		This._serviceReadyQ();
	}
};

ProcessorSystem.prototype._toActorInstance = function (actor) {
	var This = this;
	if (!(actor instanceof Processor)) {
		actor = This._processorInstances[actor].instance;
	}
	return actor;
};

ProcessorSystem.prototype._toActorName = function (actor) {
	//var This = this;
	if (actor instanceof Processor) {
		actor = actor._info.name;
	}
	return actor;
};

ProcessorSystem.prototype._push = function (from, to, body) {
	var This = this;
	from = This._toActorInstance(from);
	to = This._toActorInstance(to);
	
	var msg = {
		from: from,
		to: to,
		body: body,
		id: This._msgCount++
	};
	console.log(msg.from._info.name + " >> msg:" + msg.id + " >> " + to._info.name);
	This._enqueueMessage(msg);
};

ProcessorSystem.prototype.boot = function (actor, msg) {
	actor.send(actor, {
		message: {
			body: msg
		},
	});
};


var sys = new ProcessorSystem();

sys.registerType({
	name: "root",
	fn: function (ctx) {
		var msg = ctx.message.body;
		msg.res.writeHead(200, {'Content-Type': 'text/plain'});
		var output = "";
		for (var key in msg.req.headers) {
			output += (key + ": " + msg.req.headers[key] + "\n");
		}
		msg.res.end(output);
		return ctx.callback();
	}
});

sys.registerType({
	name: "boot",
	fn: function (ctx) {
		http.createServer(function (req, res) {
			return ctx.send(sys.create({type: "root"}), {
				req: req,
				res: res
			});
		}).listen(8000, '0.0.0.0');
	}
});

var boot = sys.create({type: "boot", name: "boot"});
sys.boot(boot, {});


