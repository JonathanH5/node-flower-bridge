var clc = require('cli-color');
var Bridge = require('./index');
var credentials = require('./credentials');

var brooklyn = new Bridge(credentials.url);
delete credentials.url;

var valid = clc.green.bold('✔');
var bad = clc.red.bold('✘');

var options = {
	type: [],
	priority: [],
};

credentials['auto-refresh'] = false;
brooklyn.loginToApi(credentials, function(err) {
	if (err) {
		console.error(err.toString());
		process.exit(1);
	}
});

brooklyn.on('login', function() {
	console.log(valid, clc.green('Login!'));
	brooklyn.all('synchronize', options);
});

brooklyn.on('newProcess', function(flowerPower) {
	console.log("[" + flowerPower.lastDate.toString().substr(4, 20) + "]:", flowerPower.name + ": " + flowerPower.lastProcess);
});

brooklyn.on('info', function(info) {
	console.log(clc.yellow("[" + info.date.toString().substr(4, 20) + "]:", info.message));
});

brooklyn.on('newState', function(state) {
	console.log(clc.xterm(0)("[" + new Date().toString().substr(4, 20) + "]:", state));
});

brooklyn.on('error', function(error) {
	console.log(clc.red("[" + error.date.toString().substr(4, 20) + "]:", error.message));
});

brooklyn.on('end', function() {
	process.exit(0);
});
