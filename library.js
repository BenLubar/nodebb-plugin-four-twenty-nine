var async = require.main.require('async');
var winston = require.main.require('winston');
var db = require.main.require('./src/database');
var pubsub = require.main.require('./src/pubsub');

var settings;

function initSettings (_settings) {
	settings = _settings;
	settings.routes.forEach(function (route) {
		route.re = new RegExp(route.path);
		route.clients = [];
	});
	winston.info('[plugin/four-twenty-nine] loaded ' + settings.routes.length + ' routes');
}

pubsub.on('fourtwentynine:settings', initSettings);

function isFlooding(url, ip) {
	var now = Date.now();

	var retryAfter = null;

	routes.some(function (route) {
		if (!route.re.test(url)) {
			return false;
		}

		if (route.time === 0) {
			return true;
		}

		var match = null;

		route.clients = route.clients.filter(function (client) {
			if (client.start < now - route.time * 1000) {
				return false;
			}

			if (client.ip === ip) {
				match = client;
			}

			return true;
		});

		if (!match) {
			match = {
				ip: ip,
				start: now,
				count: 0
			};
			route.clients.push(match);
		}

		match.count++;
		if (match.count > route.max) {
			if (match.count === route.max) {
				winston.warn('[plugin/four-twenty-nine] flooding detected: ' + ip + ' requesting "' + route.comment + '" ' + (match.count / (now - match.start) * 60000) + ' times per minute (last: ' + url + ')');
			}
			retryAfter = route.time;
		}

		return true;
	});

	return retryAfter;
}

function rateLimiter(req, res, next) {
	if (req.uid && settings.guestOnly) {
		return next();
	}

	var retryAfter = isFlooding(req.originalUrl, req.ip);
	if (retryAfter === null) {
		return next();
	}

	res.set('Retry-After', retryAfter);
	return res.sendStatus(429);
}

function saveSettings(settings, callback) {
	var _settings = {
		version: settings.version || 0,
		guestOnly: settings.guestOnly || 0,
		routes: JSON.stringify(settings.routes)
	};

	db.setObject('fourtwentynine:settings', _settings, function (err) {
		if (err) {
			return callback(err);
		}
		pubsub.publish('fourtwentynine:settings', settings);
		callback();
	});
}

module.exports = {
	"appLoad": function (data, callback) {
		async.waterfall([
			function (next) {
				db.getObject('fourtwentynine:settings', next);
			},
			function (_settings, next) {
				if (_settings) {
					_settings.version = parseInt(_settings.version || '0', 10);
					_settings.guestOnly = parseInt(_settings.guestOnly || '0', 10);
					_settings.routes = JSON.parse(_settings.routes);
					initSettings(_settings);
					return next();
				}

				_settings = {
					version: 0,
					guestOnly: 1,
					routes: [{
						path: '^/assets/',
						max: 0,
						time: 0,
						comment: 'uploaded files'
					}, {
						path: '^/(?:api/)?user/',
						max: 5,
						time: 30,
						comment: 'user profiles'
					}, {
						path: '^/(?!api/).*$',
						max: 15,
						time: 60,
						comment: 'non-API (initial load)'
					}]
				};
				saveSettings(_settings, next);
			},
			function (next) {
				data.app.use(rateLimiter);
				next();
			}
		], callback);
	}
};
