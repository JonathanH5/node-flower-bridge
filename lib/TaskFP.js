var util = require('util');
var async = require('async');
var EventEmitter = require('events');
var FlowerPower = require('flower-power-ble');

var Datastore = require('nedb');
var db = new Datastore({filename: 'database/process.db', autoload: true});

const DELAY_SEARCHING_ATTEMPT = 30000;
const DELAY_CONNECTION_ATTEMPT = 60000;
const RETRY_SEARCHING = 3;

function TaskFP(flowerPowerUuid) {
	EventEmitter.call(this);
	this.FP = null;
	this.lastDate = new Date();
	this.uuid = flowerPowerUuid;
	this.process = [];
	this.lastProcess = 'Standby';
	this.charac = {
		start_up_time: "getStartupTime",
		firmware_version: "readFirmwareRevision",
		hardware_version: "readHardwareRevision",
		history_nb_entries: "getHistoryNbEntries",
		soil_percent_vwc: 'getCalibratedSoilMoisture',
		history_last_entry_index: "getHistoryLastEntryIdx",
		history_current_session_id: "getHistoryCurrentSessionID",
		history_current_session_period: "getHistoryCurrentSessionPeriod",
		history_current_session_start_index: "getHistoryCurrentSessionStartIdx"
	};

	return this;
}

util.inherits(TaskFP, EventEmitter);

TaskFP.prototype.proc = function(processMsg, pushDb) {
	var self = this;

	self.process.unshift(processMsg);
	self.lastProcess = processMsg;
	self.lastDate = new Date();
	self.emit('newProcess', self);
	if (pushDb) {
		db.insert({
			uuid: self.uuid,
			proc: self.lastProcess,
			date: self.lastDate
		});
	}
};

TaskFP.prototype.toString = function() {
	return ("[" + this.lastDate.toString().substr(4, 20) + "]: " + this.uuid + ": " + this.lastProcess);
};

TaskFP.prototype.readDataBLE = function(keys) {
	var self = this;

	return new Promise(function(resolve, reject) {
		var array = {};
		var makeFn = function(fnName) {
			return function(callback) {
				self.FP[fnName](callback);
			};
		};

		for (var i in keys) {
			array[keys[i]] = makeFn(self.charac[keys[i]]);
		}
		async.parallel(array, function(err, results) {
			if (err) reject(err);
			else resolve(results);
		});
	});
};

TaskFP.prototype.findAndConnect = function(callback) {
	var self = this;

	async.auto({
		search: async.retry({times: RETRY_SEARCHING, interval: 2000}, self.search.bind(self)),
		init: ['search', self.init.bind(self)],
		connect: ['init', self.connect.bind(self)]
	}, callback);

};

TaskFP.prototype.search = function(callback) {
	var self = this;

	self.proc('Searching');
	var discover = function(device) {
		if (device.uuid == self.uuid) {
			self.FP = device;
			FlowerPower.stopDiscoverAll(discover);
			self.proc('Found');
			return callback(null, device);
		}
		else self.destroy(device);
	};
	setTimeout(function() {
		if (self.process[0] == 'Searching') {
			FlowerPower.stopDiscoverAll(discover);
			self.proc('Not found', true);
			return callback('Not found');
		}
	}, DELAY_SEARCHING_ATTEMPT);

	FlowerPower.discoverAll(discover);
};

TaskFP.prototype.init = function(callback) {
	var self = this;

	self.FP._peripheral.on('disconnect', function() {
		self.proc('Disconnected');
		self.destroy(self.FP);
	});
	self.FP._peripheral.on('connect', function() {
		self.proc('Connected');
	});

	switch (self.FP._peripheral.state) {
		case 'disconnected':
			self.proc('Connection');
			callback(null);
			break;
		case 'connecting':
			self.proc('Not availaible: is on connection');
			self.destroy(self.FP);
			callback('Connecting');
			break;
		default:
			self.proc('Not available: ' + self.FP._peripheral.state, true);
			self.destroy(self.FP);
			callback('Not available');
		}
};

TaskFP.prototype.connect = function(callback) {
	var self = this;

	setTimeout(function() {
		if (self.process[0] == 'Connection') {
			self.proc('Connection failed', true);
			self.destroy(self.FP);
			throw (self.FP.uuid + ': Connection failed');
		}
	}, DELAY_CONNECTION_ATTEMPT);

	self.FP.connectAndSetup(callback);
};

TaskFP.prototype.disconnect = function(callback) {
	var self = this;

	self.FP.disconnect(function() {
		if (typeof callback == 'function') {
			return callback(null);
		}
	});
};

TaskFP.prototype.destroy = function(device) {
	device._peripheral.removeAllListeners();
	device.removeAllListeners();
	device = null;
};

TaskFP.prototype.getSamples = function(index, callback) {
	var self = this;

	self.proc('Getting samples');
	self.readDataBLE([
		'start_up_time',
		'firmware_version',
		'hardware_version',
		'history_nb_entries',
		'history_last_entry_index',
		'history_current_session_id',
		'history_current_session_period',
		'history_current_session_start_index'
	]).then(function(dataBLE) {
		var hw_v = dataBLE.hardware_version;
		var fw_v = dataBLE.firmware_version;
		var firstEntryIndex = dataBLE.history_last_entry_index - dataBLE.history_nb_entries + 1;
		var startIndex = (index >= firstEntryIndex) ? index : firstEntryIndex;

		dataBLE.hardware_version = hw_v.substr(0, (hw_v.indexOf('\u0000')) ? hw_v.indexOf('\u0000') : hw_v.length);
		dataBLE.firmware_version = fw_v.substr(0, (fw_v.indexOf('\u0000')) ? fw_v.indexOf('\u0000') : fw_v.length);

		if (startIndex > dataBLE.history_last_entry_index) {
			self.proc('No update required', true);
			return callback('No update required');
		}
		self.FP.getHistory(startIndex, function(error, history) {
			dataBLE.buffer_base64 = history;
			return callback(error, dataBLE);
		});
	});
};

TaskFP.prototype.live = function(options, callback) {
	var self = this;
	var delay = 10;

	if (typeof options.delay != 'undefined') delay = options.delay;
	async.series([
		function(callback) {
			self.FP.on('sunlightChange', function(sunlight) {
				console.log('sunlight = ' + sunlight.toFixed(2) + ' mol/m²/d');
			});

			self.FP.on('soilTemperatureChange', function(temperature) {
				console.log('soil temperature = ' + temperature.toFixed(2) + '°C');
			});

			self.FP.on('airTemperatureChange', function(temperature) {
				console.log('air temperature = ' + temperature.toFixed(2) + '°C');
			});

			self.FP.on('soilMoistureChange', function(soilMoisture) {
				console.log('soil moisture = ' + soilMoisture.toFixed(2) + '%');
			});

			self.FP.on('calibratedSoilMoistureChange', function(soilMoisture) {
				console.log('calibrated soil moisture = ' + soilMoisture.toFixed(2) + '%');
			});

			self.FP.on('calibratedAirTemperatureChange', function(temperature) {
				console.log('calibrated air temperature = ' + temperature.toFixed(2) + '°C');
			});

			self.FP.on('calibratedSunlightChange', function(sunlight) {
				console.log('calibrated sunlight = ' + sunlight.toFixed(2) + ' mol/m²/d');
			});

			self.FP.on('calibratedEaChange', function(ea) {
				console.log('calibrated EA = ' + ea.toFixed(2));
			});

			self.FP.on('calibratedEcbChange', function(ecb) {
				console.log('calibrated ECB = ' + ecb.toFixed(2) + ' dS/m');
			});

			self.FP.on('calibratedEcPorousChange', function(ecPorous) {
				console.log('calibrated EC porous = ' + ecPorous.toFixed(2)+ ' dS/m');
			});
			callback();
		},
		function(callback) {
			self.proc('Live');
			self.FP.enableLiveMode(callback);
		},
		function(callback) {
			setTimeout(callback, delay * 1000);
		},
		function(callback) {
			self.proc('End live');
			self.FP.disableLiveMode(callback);
		}
	], function(err) {
		callback(err);
	});
};

TaskFP.prototype.update = function(file, callback) {
	this.proc('Update');
	this.FP.updateFirmware(file, callback);
};

module.exports = TaskFP;
