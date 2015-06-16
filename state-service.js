var _ = require('lodash'),
	EventEmitter2 = require('eventemitter2');

// this module provides a different export depending on the module loader...
EventEmitter2.EventEmitter2 && (EventEmitter2 = EventEmitter2.EventEmitter2);

var StateService = module.exports = Object.create(null, {
	_cache: { writable: true, configurable: true, value: Object.create(null) },
	_locals: { writable: true, configurable: true, value: Object.create(null) },
	bus: { writable: true, configurable: true, value: new EventEmitter2() }
});


StateService.locals = function(locals) {
	// this usually only gets set by express-engine.js
	if (locals) {
		this._locals = locals;
		return;
	}

	// if we're in the browser
	if (typeof window !== 'undefined') {
		return window.__EXACT_PROPS__ || {};
	}

	// probably on the server... #lgtm
	return this._locals;
};

// the cache is used for sharing the same state-services across multiple
// components (coordinated based on some cache key). Client-side we never have
// to worry about clearing the cache, but server-side it needs to be reset
// before each render (see boot-client.js).
StateService.cache = function(key, val) {
	if (arguments.length === 1) {
		return this._cache[key];
	}
	this._cache[key] = val;
};

StateService.clearCache = function(key) {
	if (arguments.length === 1) {
		delete this._cache[key];
	} else {
		this._cache = Object.create(null);
	}
};

StateService.reset = function() {
	this.clearCache();
	this._locals = Object.create(null);
	this.bus.removeAllListeners();
};

StateService.createFactory = function(definition) {
	// capture and cache these now
	var defaultProps = definition.getDefaultProps ?
			definition.getDefaultProps() : Object.create(null);

	return Object.create({
		create: function(props) {
			return createServiceInstance(this, props);
		},
		mixin: function(opts) {
			return createServiceMixin(this, opts);
		}
	}, {
		factoryId: { value: 'factory-' + largeRandomNumber() },
		definition: { value: definition },
		defaultProps: { value: defaultProps }
	});
};

function createServiceInstance(factory, props) {
	var definition = factory.definition;

	// before we create a new one, check if we need to return a cached instance
	props = _.assign({}, factory.defaultProps, props);

	var uniqueKey = definition.getUniqueKey ? definition.getUniqueKey(props) : null;

	// scope it to the factory
	if (uniqueKey) {
		uniqueKey = factory.factoryId + '::' + uniqueKey;
	}

	var serviceInstance;

	// return a cached instance, if appropriate
	if (uniqueKey) {
		serviceInstance = StateService.cache(uniqueKey);
		if (serviceInstance) {
			return serviceInstance;
		}
	}

	// we need to create a new one
	var proto = _.assign(
		// create a new prototype object
		{},
		// ...that includes all of our default prototype methods
		defaultServiceInstanceProto,
		// ...and all provided methods (other than the lifecycle hooks)
		_.omit(definition, [
			'getDefaultProps',
			'getUniqueKey',
			'getInitialState',
			'registeredComponentWillMount',
			'registeredComponentDidMount',
			'registeredComponentWillUnmount'
		])
	);

	serviceInstance = Object.create(proto, {
		props: { writable: true, configurable: true, value: props },
		state: { writable: true, configurable: true },
		_uuid: { value: 'state-service-' + largeRandomNumber() },
		_registeredComponents: { value: Object.create(null) },
		_registeredComponentsCount: { writable: true, configurable: true, value: 0 },
		_uniqueKey: { value: uniqueKey }
	});

	serviceInstance.state = _.assign(
		Object.create(null),
		definition.getInitialState ? definition.getInitialState.apply(serviceInstance) : {}
	);

	if (uniqueKey) {
		StateService.cache(uniqueKey, serviceInstance)
	}

	return serviceInstance;
}

var defaultServiceInstanceProto = {
	registerComponent: function(component, keys) {
		var self = this;

		// note: the act of fetching the data bag for this component effectively
		// registers it.
		var data = this.getComponentData(component);

		// store a quick lookup map of all the keys that this component is tracking
		data.keyMap = Object.create(null);
		(keys || Object.keys(this.state)).forEach(function(key) {
			data.keyMap[key] = true;
		});

		// ...and store a reference to the component itself
		data.component = component;

		this._registeredComponentsCount++;

		return this;
	},
	deregisterComponent: function(component, keys) {
		this.destroyComponentData(component);
		this._registeredComponentsCount--;
	},
	getState: function(keys) {
		return _.pick(this.state, keys || Object.keys(this.state));
	},
	setState: function(state) {
		var self = this;

		if (!state || typeof state !== 'object') {
			throw new Error('setState(state) requires state to be an object');
		}

		// update our local state copy
		_.assign(this.state, state);

		// note: calling `setState()` on a component in this loop can cause the
		// actual list of registered components to change. we don't need to
		// worry about added components, since they'll be initialized with our
		// (already updated) state object. so, we just need to check for removed
		// components on each iteration.
		Object.keys(this._registeredComponents).forEach(function(id) {
			var data = self._registeredComponents[id];

			// make sure this component wasn't removed earlier during the loop
			if (!data) return;

			var keyMap = data.keyMap,
				component = data.component;

			// create a new state object using only the keys each component is tracking
			var newState = {};
			Object.keys(state).forEach(function(key) {
				keyMap[key] && (newState[key] = state[key]);
			});

			component.setState(newState);
		});
	},
	getComponentData: function(component) {
		// first get the component's uuid
		var componentUuid = component[this._uuid + '-id'];
		if (!componentUuid) {
			componentUuid = component[this._uuid + '-id'] = largeRandomNumber();
		}

		// then get the component's data
		var data = this._registeredComponents[componentUuid];
		if (!data) {
			data = this._registeredComponents[componentUuid] = Object.create(null);
		}

		return data;
	},
	destroyComponentData: function(component) {
		// first get the component's uuid
		var componentUuid = component[this._uuid + '-id'];

		if (componentUuid) {
			delete this._registeredComponents[componentUuid];
			delete component[this._uuid + '-id'];
		}

		return this;
	}
};

function createServiceMixin(factory, opts) {
	opts || (opts = {});
	Array.isArray(opts) && (opts = { key: opts });

	var definition = factory.definition,
		service;

	return {
		getInitialState: function() {
			var props = this.props;

			if (definition.mapProps) {
				props = definition.mapProps(props);
			}

			service = factory.create(props);

			service.registerComponent(this, opts.keys);

			if (opts.ref) {
				this.serviceRefs || (this.serviceRefs = {});
				this.serviceRefs[opts.ref] = service;
			}

			return service.getState(opts.keys);
		},
		componentWillMount: function() {
			if (service._willMountInvoked) return;
			service._willMountInvoked = true;
			definition.registeredComponentWillMount &&
				definition.registeredComponentWillMount.apply(service);
		},
		componentDidMount: function() {
			if (service._didMountInvoked) return;
			service._didMountInvoked = true;
			definition.registeredComponentDidMount &&
				definition.registeredComponentDidMount.apply(service);
		},
		componentWillUnmount: function() {
			if (service._registeredComponentsCount === 1 && !service._willUnmountInvoked) {
				service._willUnmountInvoked = true;
				definition.registeredComponentWillUnmount &&
					definition.registeredComponentWillUnmount.apply(service);

				// remove from cache
				if (service._uniqueKey) {
					StateService.clearCache(service._uniqueKey);
				}
			}

			// @todo: maybe we should do a setTimeout, and then deregister, to
			// let component code still have access the service here
			service.deregisterComponent(this);

			if (opts.ref) {
				delete this.serviceRefs[opts.ref];
			}
		}
	};
}

function largeRandomNumber() {
	return Math.ceil(Math.random() * 999999999999);
}
