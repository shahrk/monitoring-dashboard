// websocket server that dashboard connects to.
const redis = require('redis');
const got = require('got');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { cp } = require('fs/promises');
const nodemailer = require('nodemailer');
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
require('dotenv').config()

const oauth2Client = new OAuth2(
	process.env.G_CLIENT_ID, // ClientID
	process.env.G_CLIENT_SECRET, // Client Secret
	"https://developers.google.com/oauthplayground" // Redirect URL
);
oauth2Client.setCredentials({
	refresh_token: process.env.G_REFRESH_TOKEN
});

// We need your host computer ip address in order to use port forwards to servers.
let serverConfig;
try {
	serverConfig = require('/root/servers.json');
}
catch (e) {
	console.log(e);
	throw new Error("Missing required /root/servers.json file");
}

/// Servers data being monitored.
var servers = [];
for (let server in serverConfig) {
	if (server !== 'monitor')
		servers.push({ name: server, ip: serverConfig[server].ip, port: serverConfig[server].port, path: serverConfig[server].path, status: "#cccccc", scoreTrend: [0] })
}

function start(app) {
	////////////////////////////////////////////////////////////////////////////////////////
	// DASHBOARD
	////////////////////////////////////////////////////////////////////////////////////////
	const io = require('socket.io')(3000);
	// Force websocket protocol, otherwise some browsers may try polling.
	io.set('transports', ['websocket']);
	// Whenever a new page/client opens a dashboard, we handle the request for the new socket.
	io.on('connection', function (socket) {
		console.log(`Received connection id ${socket.id} connected ${socket.connected}`);

		if (socket.connected) {
			//// Broadcast heartbeat event over websockets ever 1 second
			var heartbeatTimer = setInterval(function () {
				socket.emit("heartbeat", servers);
			}, 1000);

			//// If a client disconnects, we will stop sending events for them.
			socket.on('disconnect', function (reason) {
				console.log(`closing connection ${reason}`);
				clearInterval(heartbeatTimer);
			});
		}
	});

	/////////////////////////////////////////////////////////////////////////////////////////
	// REDIS SUBSCRIPTION
	/////////////////////////////////////////////////////////////////////////////////////////
	let client = redis.createClient(6379, 'localhost', {});
	let client_kv = redis.createClient(6379, 'localhost', {});
	// We subscribe to all the data being published by the server's metric agent.
	for (var server of servers) {
		// The name of the server is the name of the channel to recent published events on redis.
		client.subscribe(server.name);
	}

	// When an agent has published information to a channel, we will receive notification here.
	client.on("message", async function (channel, message) {
		console.log(`Received message from agent: ${channel}`)
		await client_kv.connect();
		const cpu_threshold = await client_kv.get('alert_cpu_threshold');
		const memory_threshold = await client_kv.get('alert_memory_threshold');
		const email = await client_kv.get('alert_email');
		for (var server of servers) {
			// Update our current snapshot for a server's metrics.
			if (server.name == channel) {
				let payload = JSON.parse(message);
				server.memoryLoad = payload.memoryLoad;
				server.cpu = payload.cpu;
				if ((cpu_threshold && server.cpu > cpu_threshold) || (memory_threshold && server.memoryLoad > memory_threshold)) {
					console.log("LLOOOOJJJJKKKK");
					console.log(cpu_threshold, server.cpu, memory_threshold, server.memoryLoad);
					const accessToken = oauth2Client.getAccessToken();
					const transporter = nodemailer.createTransport({
						host: "smtp.gmail.com",
						port: 465,
						auth: {
							type: "OAuth2",
							user: 'ncsudevops24@gmail.com',
							clientId: process.env.G_CLIENT_ID,
							clientSecret: process.env.G_CLIENT_SECRET,
							refreshToken: process.env.G_REFRESH_TOKEN,
							accessToken: accessToken
						},
						tls: {
							rejectUnauthorized: false
						}
					});
					console.log(server.cpu, cpu_threshold, server.memoryLoad, memory_threshold);
					let mailOptions = {
						from: 'ncsudevops24@gmail.com',
						to: email,
						subject: `Alert: Server Metric exceeded threshold`,
						text: `Server CPU usage: ${server.cpu}%\nServer Memory usage: ${server.memoryLoad}%`
					};
					transporter.sendMail(mailOptions, function (error, info) {
						if (error) {
							console.log(error);
						} else {
							console.log('Email sent: ' + info.response);
						}
					});
				}
				updateHealth(server);
			}
		}
	});

	// LATENCY CHECK
	var latency = setInterval(function () {
		for (var server of servers) {
			if (server.ip) {
				if (!server.port) {
					server.port = 8080;
				}
				if (!server.path) {
					server.path = "";
				}
				server.url = `http://${server.ip}:${server.port}/${server.path}`;
				console.log(`Trying to reach ${server.url}`);
				let now = Date.now();

				// Bind a new variable in order to for it to be properly captured inside closure.
				let captureServer = server;

				// Make request to server we are monitoring.
				let start = performance.now();
				got(server.url, { timeout: 5000, throwHttpErrors: false }).then(function (res) {
					// TASK 2
					captureServer.statusCode = res.statusCode;
					captureServer.latency = performance.now() - start;
				}).catch(e => {
					// console.log(e);
					captureServer.statusCode = e.code;
					captureServer.latency = 5000;
				});
			}
		}
	}, 10000);
}

// TASK 3
function updateHealth(server) {
	let score = 0;
	// Update score calculation.
	let latencyScore = (5000 - server.latency) / 5000;
	let statusScore = 1;
	let memoryScore = 1 - (server.memoryLoad / 100);
	let cpuScore = 1 - (server.cpu / 100);
	if (server.statusCode !== 200)
		statusScore = 0;
	score = latencyScore + statusScore + memoryScore + cpuScore;

	server.status = score2color(score / 4);

	console.log(`${server.name} ${score}`);

	// Add score to trend data.
	server.scoreTrend.push((4 - score));
	if (server.scoreTrend.length > 100) {
		server.scoreTrend.shift();
	}
}

function score2color(score) {
	if (score <= 0.25) return "#ff0000";
	if (score <= 0.50) return "#ffcc00";
	if (score <= 0.75) return "#00cc00";
	return "#00ff00";
}

module.exports.start = start;