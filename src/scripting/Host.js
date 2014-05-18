var CCLScripting = function(workerUrl){
	this.version = 1.0;
	this.workerUrl = workerUrl;
	this.logger = new function(){
		this.log = function(m){
			console.log(m);
		};
		this.error = function(m){
			console.error(m);
		};
		this.warn = function(m){
			console.warn(m);
		};
	};
	this.getWorker = function(){
		return new Worker(this.workerUrl);
	};
	this.getScriptingContext = function(stage){
		return new this.ScriptingContext(this, stage);
	};
	this.getSandbox = function(stage, player){
		return new this.BridgedSandbox(this, stage, player);
	};
};

(function(){
	if(!CCLScripting){
		throw new Error("CCL: Scripting engine not defined.");
		return;
	}
	
	CCLScripting.prototype.ScriptingContext = function(scripter, stage){
		// Here in the Scripting Context we also have a objects
		var objects = {};
		this.registerObject = function(objectId, serialized){
			if(typeof this.Unpack[serialized["class"]] === "function"){
				objects[objectId] = new this.Unpack[serialized["class"]](stage, 
					serialized, this);
			}else{
				scripter.logger.error("Cannot unpack class \"" + 
					serialized["class"] + "\". No valid unpacker found");
				return;
			}
		};
		
		this.deregisterObject = function(objectId){
			delete objects[objectId];
		};
		
		this.callMethod = function(objectId, methodName, params){
			if(!objects[objectId]){
				scripter.logger.error("Object not found.");
				return;
			}
			if(!objects[objectId][methodName]){
				scripter.logger.error("Method \"" + methodName 
					+ "\" not defined for object of type " + 
					objects[objectId].getClass() +".");
				return;
			}
			try{
				objects[objectId][methodName](params);
			}catch(e){
				if(e.stack){
					scripter.logger.error(e.stack);
				}else{
					scripter.logger.error(e.toString());
				};
			}
		};
		
		this.clear = function(){
			
		};
		
		this.getDimensions = function(){
			return {
				"stageWidth":stage.offsetWidth,
				"stageHeight":stage.offsetHeight,
				"screenWidth":window.screen.width,
				"screenHeight":window.screen.height
			};
		};
	};
	
	CCLScripting.prototype.ScriptingContext.prototype.Unpack = {};
	
	CCLScripting.prototype.BridgedSandbox = function(scripter, stage, player){
		var worker = scripter.getWorker();
		var context = scripter.getScriptingContext(stage);
		var playerAbst = player;
		var channels = {};
		var isRunning = false;
		var sandbox = this;
		
		if(!worker){
			throw new Error("SANDBOX: Worker pool exhausted.");
		}
		
		this.getLogger = function(){
			return scripter.logger;
		};
		
		this.getPlayer = function(){
			return playerAbst;
		};
		
		this.getContext = function(){
			return context;
		};
		
		this.addListener = function(channel, listener){
			if(!channels[channel]){
				channels[channel] = {
					"max":0,
					"listeners":[]
				};
			}
			if(channels[channel].max > 0){
				if(channels[channel].listeners.length >= channels[channel].max){
					return false;
				}
			}
			channels[channel].listeners.push(listener);
			return true;
		};
		
		var dispatchMessage = function(msg){
			if(channels[msg.channel] && channels[msg.channel].listeners){
				for(var i = 0; i < channels[msg.channel].listeners.length; i++){
					channels[msg.channel].listeners[i](msg.payload);
				}
			}else{
				scripter.logger.warn("Message for channel \"" + msg.channel + 
					"\" but channel not existant.");
			}
		};
		
		var WorkerHook = function(event){
			try{
				var resp = JSON.parse(event.data);	
			}catch(e){
				console.log(e);
				return;
			}
			if(resp.channel === ""){
				switch(resp.mode){
					case "log":
					default:{
						scripter.logger.log(resp.obj);
						break;
					}
					case "warn":{
						scripter.logger.warn(resp.obj);
						break;
					}
					case "err":{
						scripter.logger.error(resp.obj);
						break;
					}
					case "fatal":{
						scripter.logger.error(resp.obj);
						sandbox.resetWorker();
						return;
					}
				};
				return;
			}
			if(resp.channel.substring(0,8) === "::worker"){
				var RN = resp.channel.substring(8);
				switch(RN){
					case ":state":{
						if(resp.payload === "running" && resp.auth === "worker"){
							isRunning = true;
							channels = {};
							sandbox.init();
						}
						break;
					}
					default:{
						console.log(resp);
						break;
					}
				}
			}else{
				dispatchMessage(resp);
			}
		};
		
		this.resetWorker = function(){
			try{
				worker.terminate();
			}catch(e){}
			worker = scripter.getWorker();
			if(!worker){
				throw new Error("SANDBOX: Worker pool exhausted.");
			}
			worker.addEventListener("message", WorkerHook);
		};
		
		worker.addEventListener("message", WorkerHook);
		
		this.eval = function(code){
			// Pushes the code to be evaluated on the Worker
			if(!isRunning){
				throw new Error("Worker offline");
			}
			worker.postMessage(JSON.stringify({
				"channel":"::eval",
				"payload":code
			}));
		};
		
		this.send = function(channel, payload){
			// Low level send
			worker.postMessage(JSON.stringify({
				"channel":channel,
				"payload":payload
			}));
		};
	};
	CCLScripting.prototype.BridgedSandbox.prototype.init = function(){
		var self = this;
		/** Post whatever we need to **/
		self.send("Update:dimension", self.getContext().getDimensions());
		/** Hook Listeners **/
		this.addListener("Runtime::alert", function(msg){
			alert(msg);
		});
		this.addListener("Runtime::clear", function(){
			self.getContext().clear();
		});
		this.addListener("Player::action", function(msg){
			try{
				switch(msg.action){
					default:return;
					case "play": self.getPlayer().play();break;
					case "pause": self.getPlayer().pause();break;
					case "seek": self.getPlayer().seek(msg.offset);break;
					case "jump": self.getPlayer().jump(msg.params);break;
				}
			}catch(e){
				if(e.stack){
					self.getLogger().error(e.stack);
				}else{
					self.getLogger().error(e.toString());	
				}
			}
		});
		this.addListener("Runtime:RegisterObject", function(pl){
			self.getContext().registerObject(pl.id, pl.data);
		});
		this.addListener("Runtime:DeregisterObject", function(pl){
			self.getContext().deregisterObject(pl.id);
		});
		this.addListener("Runtime:CallMethod", function(pl){
			self.getContext().callMethod(pl.id, pl.method, pl.params);
		});
	};
	/** This is the DOM Manipulation Library **/
	var _ = function (type, props, children, callback) {
		var elem = null;
		if (type === "text") {
			return document.createTextNode(props);
		} else if(type === "svg"){
			elem = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		}else {
			elem = document.createElement(type);
		}
		for(var n in props){
			if(n !== "style" && n !== "className"){
				elem.setAttribute(n, props[n]);
			}else if(n === "className"){
				elem.className = props[n];
			}else{
				for(var x in props.style){
					elem.style[x] = props.style[x];
				}
			}
		}
		if (children) {
			for(var i = 0; i < children.length; i++){
				if(children[i] != null)
					elem.appendChild(children[i]);
			}
		}
		if (callback && typeof callback === "function") {
			callback(elem);
		}
		return elem;
	};
	/** Define some unpackers **/
	var ScriptingContext = CCLScripting.prototype.ScriptingContext;
	ScriptingContext.prototype.Unpack.Comment = function(stage, data, ctx){
		this.DOM = _("div",{});
		/** Load the text format **/
		this.DOM.appendChild(document.createTextNode(data.text));
		this.DOM.style.fontFamily = data.textFormat.font;
		this.DOM.style.fontSize = data.textFormat.size + "px";
		this.DOM.style.color = "#" + data.textFormat.color.toString(16);
		if(data.textFormat.bold)
			this.DOM.style.fontWeight = "bold";
		if(data.textFormat.underline)
			this.DOM.style.textDecoration = "underline";
		if(data.textFormat.italic)
			this.DOM.style.fontStyle = "italic";
		this.DOM.style.margin = data.textFormat.margin;
		
		this.setFilters = function(params){
			for(var i = 0; i < params[0].length; i++){
				var filter = params[0][i];
				if(filter.type === "blur"){
					this.DOM.style.color = "transparent";
					this.DOM.style.textShadow = [-filter.params.blurX + "px",
						-filter.params.blurY + "px", Math.max(
							filter.params.blurX, filter.params.blurY) + 
						"px"].join(" "); 
				}else if(filter.type === "glow"){
					this.DOM.style.textShadow = [-filter.params.blurX + "px",
						-filter.params.blurY + "px", Math.max(
							filter.params.blurX, filter.params.blurY) + 
						"px", "#" + filter.params.color.toString(16)].join(" "); 
				}
			};
		};
		
		// Hook child
		stage.appendChild(this.DOM);
	};
	
	ScriptingContext.prototype.Unpack.Shape = function(stage, data, ctx){
		this.DOM = _("svg",{
			"width":stage.offsetWidth, 
			"height":stage.offsetHeight,
			"style":{
				"position":"absolute",
				"top": (data.y ? data.y : 0) + "px",
				"left":(data.x ? data.x : 0) + "px"
		}});
		// Helpers
		var __ = function(e, attr){
			if(typeof e === "string"){
				var elem = 
					document.createElementNS("http://www.w3.org/2000/svg",e);
			}else{
				var elem = e;
			}
			if(attr){
				for(var x in attr){
					elem.setAttribute(x, attr[x]);
				}
			}
			return elem;
		};
		
		this.line = {
			width:1,
			color:"#FFFFFF",
			alpha:1
		};
		this.fill = {
			fill:"none",
			alpha:1
		};
		
		var applyStroke = function(p, ref){
			__(p, {
				"stroke": ref.line.color,
				"stroke-width": ref.line.width,
				"stroke-opacity": ref.line.alpha
			});
			if(ref.line.caps){
				p.setAttribute("stroke-linecap", ref.line.caps);
			}
			if(ref.line.joints){
				p.setAttribute("stroke-linejoin", ref.line.joints);
			}
			if(ref.line.miterLimit){
				p.setAttribute("stroke-miterlimit", ref.line.miterLimit);
			}
		};
		
		var applyFill = function(p, ref){
			__(p, {
				"fill": ref.fill.fill,
				"fill-opacity": ref.fill.alpha
			});
		};
		
		var state = {lastPath : null};
		this.moveTo = function(params){
			var p = __("path",{
				"d":"M" + params.join(" ")
			});
			applyFill(p, this);
			state.lastPath = p;
			applyStroke(p, this);
			this.DOM.appendChild(state.lastPath);
		};
		this.lineTo = function(params){
			if(!state.lastPath){
				state.lastPath = __("path",{
					"d":"M0 0"
				});
				applyFill(state.lastPath, this);
				applyStroke(state.lastPath, this);
			}
			__(state.lastPath,{
				"d": state.lastPath.getAttribute("d") + " L" + params.join(" ")
			});
		};
		this.curveTo = function(params){
			if(!state.lastPath){
				state.lastPath = __("path",{
					"d":"M0 0"
				});
				applyFill(state.lastPath, this);
				applyStroke(state.lastPath, this);
			}
			__(state.lastPath,{
				"d": state.lastPath.getAttribute("d") + " Q" + params.join(" ")
			});
		};
		this.lineStyle = function(params){
			if(params.length < 3)
				return;
			this.line.width = params[0];
			this.line.color = params[1];
			this.line.alpha = params[2];
			if(params[3]){
				this.line.caps = params[3];
			}
			if(params[4]){
				this.line.joints = params[4];
			}
			if(params[5]){
				this.line.miterLimit = params[5];
			}
			if(state.lastPath){
				applyStroke(state.lastPath, this);
			}
		};
		this.beginFill = function(params){
			if(params.length === 0)
				return;
			this.fill.fill = params[0];
			if(params.length > 1){
				this.fill.alpha = params[1];
			}
		};
		this.endFill = function(params){
			this.fill.fill = "none";
		};
		this.drawRect = function(params){
			var r = __("rect",{
				"x": params[0],
				"y": params[1],
				"width": params[2],
				"height": params[3]
			});
			applyFill(r, this);
			applyStroke(r, this);
			this.DOM.appendChild(r);
		};
		this.drawRoundRect = function(params){
			var r = __("rect",{
				"x": params[0],
				"y": params[1],
				"width": params[2],
				"height": params[3],
				"rx":params[4],
				"ry":params[5]
			});
			applyFill(r, this);
			applyStroke(r, this);
			this.DOM.appendChild(r);
		};
		this.drawCircle = function(params){
			var c = __("circle",{
				"cx": params[0],
				"cy": params[1],
				"r": params[2]
			});
			applyFill(c, this);
			applyStroke(c, this);
			this.DOM.appendChild(c);
		};
		
		this.drawEllipse = function(params){
			var e = __("ellipse",{
				"cx": params[0],
				"cy": params[1],
				"rx": params[2],
				"ry": params[3]
			});
			applyFill(e, this);
			applyStroke(e, this);
			this.DOM.appendChild(e);
		};
		
		// Hook Child
		stage.appendChild(this.DOM);
	};
	
	ScriptingContext.prototype.Unpack.Canvas = function(stage, data, ctx){
		this.DOM = _("div",{"style":{"position":"absolute"}});
		
		this.setX = function(x){
			this.DOM.style.left = x + "px";
		};
		
		this.setY = function(y){
			this.DOM.style.top = y + "px";
		};
		
		this.setWidth = function(width){
			this.DOM.style.width = width + "px";
		};
		
		this.setHeight = function(height){
			this.DOM.style.height = height + "px";
		};
		
		// Hook child
		stage.appendChild(this.DOM);
	}
	
	// Load all the getClass Prototypes
	for(var cl in ScriptingContext.prototype.Unpack){
		ScriptingContext.prototype.Unpack[cl].prototype.getClass = (function(){
			var n = cl;
			return function(){
				return n;
			} 
		})();
	}
})();
