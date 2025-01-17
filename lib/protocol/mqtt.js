'use strict';

const BaseClient = require(__dirname + '/base').BaseClient;
const BaseServer = require(__dirname + '/base').BaseServer;
const datapoints = require(__dirname + '/../datapoints');

const mqtt = require('mqtt-connection');
const net = require('net');

/**
 * checks if  funcito is an asynchron function
 * @param {function} funct - function
 */
function isAsync(funct) {
    if (funct && funct.constructor) return funct.constructor.name == 'AsyncFunction';
    return undefined;
}

class MQTTClient extends BaseClient {
    constructor(adapter, objectHelper, eventEmitter, stream) {

        super('mqtt', adapter, objectHelper, eventEmitter);

        this.stream = stream;

        this.packet;
        this.mqttprefix;
        this.qos = {};
        this.messageId = 1;
        this.will = undefined;

        this.client;

        this.start();
    }

    start() {
        this.client = mqtt(this.stream);
        this.listener();
    }

    /**
     * to get sure, that an instance will be start more than one, we check for running instances
     * if an instance run with same name (shellyswitch-12345), we destroy the old instance
     * @param {object} self - my instance
     */
    static _registerRun(self) {
        if (self) {
            if (!this.clientlist) this.clientlist = {};
            const name = self.getId();
            if (name && this.clientlist[name]) this.clientlist[name].destroy();
            this.clientlist[name] = self;
        }
    }

    /**
     * IP of Shelly device
     * Example 192.168.1.2
     * @return {String}
     */
    getIP() {
        if (!this.ip) {
            if (this.stream && this.stream.remoteAddress) this.ip = this.stream.remoteAddress;
        }
        return this.ip;
    }

    /**
     * Get the ID of the Shelly device
     * Example: shellyplug-s-12345
     */
    getId() {
        if (!this.id) {
            if (this.packet && this.packet.clientId) this.id = this.packet.clientId;
        }
        return this.id;
    }

    /**
     * Get the Shelly device type with the serialnumber of the device
     * Device type could be for example SHRGBW2. The serial number of the
     * device like 1234 will be added
     * Example: SHRGBW2#1234#1
     */
    getDeviceId() {
        if (!this.deviceId) {
            const deviceType = this.getDeviceType();
            const serialId = this.getSerialId();
            if (deviceType && serialId) {
                this.deviceId = deviceType + '#' + serialId + '#1';
            }
        }
        return this.deviceId;
    }

    /**
     * Get the Shelly Device type without serialnumber of the device
     * Example: SHRGBW2
     */
    getDeviceType() {
        if (!this.deviceType) {
            const deviceClass = this.getDeviceClass();
            this.deviceType = datapoints.getDeviceTypeByClass(deviceClass);
        }
        return this.deviceType;
    }

    /**
     * Get the device id without serial number
     * Example: shellyplug-s
     */
    getDeviceClass() {
        if (!this.deviceClass) {
            let id = this.getId();
            if (id) {
                id = id.replace(/(.+?)\/(.+?)\/(.*)/, '$2');
                this.deviceClass = id.replace(/(.+)-(.+)/, '$1');
            }
        }
        return this.deviceClass;
    }

    /**
     * Serial id of the Shelly device
     * Example: shellyplug-s-12345
     */
    getSerialId() {
        if (!this.serialId) {
            let id = this.getId();
            if (id) {
                id = id.replace(/(.+?)\/(.+?)\/(.*)/, '$2');
                this.serialId = id.replace(/(.+)-(.+)/, '$2');
            }
        }
        return this.serialId;
    }

    getMqttPrefix() {
        return this.mqttprefix;
    }

    /**
     * Cleanup, destroy this object
     */
    destroy() {
        super.destroy();
        this.adapter.log.debug(`[MQTT] Destroying: ${this.getLogInfo()}`);
        this.adapter.deviceStatusUpdate(this.getDeviceId(), false); // Device offline

        for (const messageId in this.qos) {
            if (this.qos[messageId].resendid) clearTimeout(this.qos[messageId].resendid);
        }

        this.qos = {};
        this.messageId = 1;
        this.mqttprefix = undefined;
        this.will = undefined;

        if (this.client) {
            this.client.removeAllListeners();
            this.client.destroy();
        }
    }

    /**
     * Sends MQTT Messages, for example to change a state
     * @param {*} topic
     * @param {*} state
     * @param {*} qos
     * @param {*} dup
     * @param {*} retain
     * @param {function} cb
     */
    sendState2Client(topic, state, qos, dup, retain, cb) {
        if (typeof qos === 'function') {
            cb = qos;
            dup = false;
            qos = undefined;
        }
        if (typeof dup === 'function') {
            cb = dup;
            dup = false;
            retain = undefined;
        }
        if (typeof retain === 'function') {
            cb = retain;
            retain = undefined;
        }
        qos = qos ? Number.parseInt(qos) : 0;
        this.messageId &= 0xFFFFFFFF;
        this.messageId++;

        try {
            this.adapter.log.debug(`[MQTT] Send state to ${this.getLogInfo()}: ${topic} = ${state} (${this.messageId})`);
            this.client.publish({ topic: topic, payload: state, qos: qos, retain: retain, messageId: this.messageId }, cb);
        } catch (err) {
            this.adapter.log.debug(`[MQTT] Client communication error (publish): ${this.getLogInfo()} - error: ${err}`);
        }

        // if qos > 0 recognize message
        if (qos > 0) {
            this.deleteResendState2ClientFromTopic(topic);
            this.resendState2Client('publish', this.messageId, { topic: topic, payload: state, qos: qos, dup: true, retain: retain, messageId: this.messageId });
        }
    }

    resendState2Client(cmd, messageId, message) {
        const retaintime = 5 * 1000;
        if (!this.qos[messageId] || this.qos[messageId].cmd !== cmd || this.qos[messageId].message !== message) {
            this.qos[messageId] = {
                ts: Date.now(),
                cmd: cmd,
                count: 0,
                message: message
            };
        }
        if (this.qos[messageId] && this.qos[messageId].count < 10) {
            clearTimeout(this.qos[messageId].resendid);
            this.qos[messageId].resendid = setTimeout(() => {
                if (this.qos[messageId]) {
                    const ts = Date.now();
                    this.qos[messageId].count++;
                    this.qos[messageId].ts = ts;
                    switch (this.qos[messageId].cmd) {
                        case 'publish':
                            try {
                                this.client.publish(this.qos[messageId].message);
                            } catch (err) {
                                this.adapter.log.debug(`[MQTT] Client communication error (publish): ${this.getLogInfo()} - error: ${err}`);
                            }

                            break;
                        case 'pubrel':
                            try {
                                this.client.pubrel({ messageId: messageId });
                            } catch (err) {
                                this.adapter.log.debug(`[MQTT] Client communication error (pubrel): ${this.getLogInfo()} - error: ${err}`);
                            }

                            break;
                        case 'pubrec':
                            try {
                                this.client.pubrec({ messageId: messageId });
                            } catch (err) {
                                this.adapter.log.debug(`[MQTT] Client communication error (pubrec): ${this.getLogInfo()} - error: ${err}`);
                            }

                            break;
                        case 'pubcomp':
                            try {
                                this.client.pubcomp({ messageId: messageId });
                            } catch (err) {
                                this.adapter.log.debug(`[MQTT] Client communication error (pubcomp): ${this.getLogInfo()} - error: ${err}`);
                            }

                            break;
                        default:
                            break;
                    }

                    this.resendState2Client(cmd, messageId, message);
                }
            }, retaintime);
        }
    }

    deleteResendState2Client(messageId) {
        if (this.qos[messageId]) {
            clearTimeout(this.qos[messageId].resendid);
            delete this.qos[messageId];
        }
    }

    deleteResendState2ClientFromTopic(topic) {
        for (const messageId in this.qos) {
            if (this.qos[messageId].message && this.qos[messageId].cmd === 'publish' && this.qos[messageId].message.topic === topic) {
                clearTimeout(this.qos[messageId].resendid);
                delete this.qos[messageId];
            }
        }
    }

    getResendState2Client(messageId) {
        return this.qos[messageId];
    }

    getDevices(topic) {
        const states = [];
        for (const i in this.device) {
            const state = this.device[i];
            if (state.mqtt && state.mqtt.mqtt_publish && topic === state.mqtt.mqtt_publish) {
                states.push(state);
            }
        }
        return states;
    }

    /**
     * State changes from device will be saved in the ioBroker states
     * @param {object} payload - object can be ervery type of value
     */
    async createIoBrokerState(topic, payload) {
        this.adapter.log.silly(`[MQTT] Message for ${this.getLogInfo()}: ${topic} / ${JSON.stringify(payload)} (${payload.toString()})`);

        const dps = this.getDevices(topic);
        for (const i in dps) {
            const dp = dps[i];
            const deviceId = this.getDeviceId();
            const stateid = `${deviceId}.${dp.state}`;
            let value = payload.toString();

            this.adapter.log.silly(`[MQTT] Message with value for ${this.getLogInfo()}: ${topic} -> state: ${stateid}, value: ${value}`);

            try {
                if (dp.mqtt && dp.mqtt.mqtt_publish === topic) {
                    if (dp.mqtt && dp.mqtt.mqtt_publish_funct) {
                        value = isAsync(dp.mqtt.mqtt_publish_funct) ? await dp.mqtt.mqtt_publish_funct(value, this) : dp.mqtt.mqtt_publish_funct(value, this);
                    }

                    if (dp.common.type === 'boolean' && value === 'false') value = false;
                    if (dp.common.type === 'boolean' && value === 'true') value = true;
                    if (dp.common.type === 'number' && value !== undefined) value = Number(value);

                    if (value !== undefined && (!Object.prototype.hasOwnProperty.call(this.states, stateid) || this.states[stateid] !== value || this.adapter.config.updateUnchangedObjects)) {
                        this.adapter.log.debug(`[MQTT] State change ${this.getLogInfo()}: ${topic} -> state: ${stateid}, value: ${JSON.stringify(value)}`);
                        this.states[stateid] = value;
                        this.objectHelper.setOrUpdateObject(stateid, {
                            type: 'state',
                            common: dp.common
                        }, ['name'], value);
                    }
                }
            } catch (error) {
                this.adapter.log.error(`[MQTT] Error ${error} in function dp.mqtt.mqtt_publish_funct of state ${stateid} for ${this.getLogInfo()}`);
            }
        }
        this.objectHelper.processObjectQueue(() => { });
    }

    async setMqttPrefixHttp() {
        if (this.mqttprefix) {
            return this.mqttprefix;
        }

        if (this.getDeviceGen() == 1) {
            try {
                const body = await this.requestAsync('/settings');
                if (body) {
                    const settings = JSON.parse(body);
                    this.mqttprefix = settings.mqtt.id;

                    this.adapter.log.debug(`[MQTT] Requested mqttprefix for ${this.getLogInfo()} (Gen 1): ${this.mqttprefix}`);

                    return this.mqttprefix;
                }
            } catch (err) {
                if (err && err.response && err.response.status == 401) {
                    this.adapter.log.error(`[MQTT] Wrong http username or http password! Please enter the user credential from restricted login for ${this.getLogInfo()}`);
                } else {
                    this.adapter.log.error(`[MQTT] Error in function setMqttPrefixHttp (Gen 1) for ${this.getLogInfo()}: ${err}`);
                }
            }
        } else if (this.getDeviceGen() == 2) {
            try {
                const body = await this.requestAsync('/rpc/Mqtt.GetConfig');
                if (body) {
                    const settings = JSON.parse(body);
                    this.mqttprefix = settings.topic_prefix;

                    this.adapter.log.debug(`[MQTT] Requested mqttprefix for ${this.getLogInfo()} (Gen 2): ${this.mqttprefix}`);

                    return this.mqttprefix;
                }
            } catch (err) {
                this.adapter.log.error(`[MQTT] Error in function setMqttPrefixHttp (Gen 2) for ${this.getLogInfo()}: ${err}`);
            }
        }

        return undefined;
    }

    setMqttPrefixByWill(topic) {
        // Gen1: "shellies/huhu-shellybutton1-A4CF12F454A3/online"
        // Gen2: "shellyplus1pm-44179394d4d4/online"

        if (this.mqttprefix) {
            return this.mqttprefix;
        } else {
            if (topic) {
                const arr = topic.split('/');
                if (this.getDeviceGen() == 1) {
                    if (arr[0] === 'shellies') {
                        this.mqttprefix = arr[1];
                        this.adapter.log.debug(`[MQTT] setMqttPrefixByWill (Gen 1): ${this.mqttprefix}`);
                        return this.mqttprefix;
                    }
                } else if (this.getDeviceGen() == 2) {
                    this.mqttprefix = arr.slice(0, -1).join('/');
                    this.adapter.log.debug(`[MQTT] setMqttPrefixByWill (Gen 2): ${this.mqttprefix}`);
                    return this.mqttprefix;
                }
            }
            return undefined;
        }
    }

    listener() {
        // client connected
        this.client.on('connect', async (packet) => {
            this.packet = packet;
            this.adapter.log.debug(`[MQTT] Client connected: ${JSON.stringify(packet)}`);
            if (this.deviceExists()) {
                if (packet.username === this.adapter.config.mqttusername && packet.password !== undefined && packet.password.toString() === this.adapter.config.mqttpassword) {
                    // check for existing instances
                    MQTTClient._registerRun(this);
                    const polltime = this.getPolltime();
                    if (polltime > 0) {
                        this.adapter.log.info(`[MQTT] Device ${this.getLogInfo()} connected! Polltime set to ${polltime} sec.`);
                    } else {
                        this.adapter.log.info(`[MQTT] Device ${this.getLogInfo()} connected! No polling`);
                    }

                    // Save last will
                    // Gen 1: {"retain": false, "qos": 0, "topic" :"shellies/shellyswitch25-C45BBE798F0F/online", "payload": {"type":"Buffer","data": [102,97,108,115,101]}}
                    // Gen 2: {"retain": false, "qos": 0, "topic": "shellypro2pm-30c6f7850a64/online", "payload": {"type":"Buffer","data":[102,97,108,115,101]}}
                    if (packet.will) {
                        this.will = packet.will;
                        this.adapter.log.debug(`[MQTT] Last will for ${this.getLogInfo()} saved: ${JSON.stringify(this.will)}`);
                    }

                    if (this.will && this.will.topic) {
                        this.setMqttPrefixByWill(this.will.topic);
                    } else {
                        await this.setMqttPrefixHttp();
                    }

                    if (!this.mqttprefix) {
                        this.adapter.log.error(`[MQTT] Unable to get mqttprefix for ${this.getLogInfo()}`);
                    }

                    // Device Mode information (init)
                    await this.initDeviceModeFromState();

                    await this.deleteOldStates();
                    await this.createObjects();

                    // Fill hostname
                    await this.adapter.setStateAsync(`${this.getDeviceId()}.hostname`, { val: this.getIP(), ack: true });
                    this.adapter.deviceStatusUpdate(this.getDeviceId(), true); // Device online

                    this.httpIoBrokerState();

                    try {
                        this.client.connack({ returnCode: 0 });

                        // Device Mode information (request)
                        if (this.getDeviceGen() == 2) {
                            try {
                                this.messageId &= 0xFFFFFFFF;
                                this.messageId++;

                                this.client.publish({
                                    topic: `${this.mqttprefix}/rpc`,
                                    payload: JSON.stringify({id: 0, src: 'iobroker', method: 'Shelly.GetDeviceInfo', params: { ident: true }}),
                                    qos: this.adapter.config.qos,
                                    messageId: this.messageId
                                });
                            } catch (err) {
                                this.adapter.log.debug(`[MQTT] Client communication error (publish): ${this.getLogInfo()} - error: ${err}`);
                            }
                        }
                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Client communication error (connack): ${this.getLogInfo()} - error: ${err}`);
                    }
                } else {
                    this.adapter.log.error(`[MQTT] Wrong MQTT authentification for: ${this.getLogInfo()}`);

                    try {
                        this.client.connack({ returnCode: 4 });
                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Client communication error (connack): ${this.getLogInfo()} - error: ${err}`);
                    }
                }
            } else {
                this.adapter.log.error(`[MQTT] (Shelly?) device unknown, configuration for Shelly device ${this.getLogInfo()} does not exist!`);

                try {
                    this.client.connack({ returnCode: 4 });
                } catch (err) {
                    this.adapter.log.debug(`[MQTT] Client communication error (connack): ${this.getLogInfo()} - error: ${err}`);
                }
            }
        });

        this.client.on('close', (status) => {
            this.adapter.log.info(`[MQTT] Client Close: ${this.getLogInfo()} (${status})`);
            this.destroy();
        });

        this.client.on('error', (error) => {
            this.adapter.log.info(`[MQTT] Client Error: ${this.getLogInfo()} (${error})`);
            // this.destroy();
        });

        this.client.on('disconnect', () => {
            this.adapter.log.info(`[MQTT] Client Disconnect: ${this.getLogInfo()}`);
            this.destroy();
        });

        this.client.on('timeout', () => {
            this.adapter.log.info(`[MQTT] Client Timeout: ${this.getLogInfo()}`);
            // this.destroy();
        });

        this.client.on('publish', async (packet) => {
            if (this.adapter.isUnloaded) return;

            this.adapter.log.silly(`[MQTT] Publish: ${this.getLogInfo()} - ${JSON.stringify(packet)}`);
            if (packet.payload) {
                this.adapter.log.debug(`[MQTT] Publish: ${this.getLogInfo()} - topic: ${packet.topic}, payload: ${packet.payload.toString()}`);

                // Generation 1
                if (this.getDeviceGen() == 1 && packet.topic === 'shellies/announce') {
                    try {
                        const payloadObj = JSON.parse(packet.payload);

                        const ip = payloadObj?.ip;
                        if (ip && ip !== this.ip) {
                            this.adapter.log.debug(`[MQTT] Reassigning ip address for ${this.getLogInfo()}: "${this.ip}" to "${ip}"`);

                            this.ip = ip;

                            await this.adapter.setStateAsync(`${this.getDeviceId()}.hostname`, { val: this.getIP(), ack: true });
                            this.adapter.deviceStatusUpdate(this.getDeviceId(), true); // Device online
                        }

                        // Device Mode information (new)
                        const newDeviceMode = payloadObj?.mode;
                        if (newDeviceMode) {
                            await this.setDeviceMode(newDeviceMode);
                        }
                    } catch (error) {
                        // we do not change anything
                    }
                }

                // Generation 2
                if (this.getDeviceGen() == 2) {
                    if (packet.topic == 'iobroker/rpc') {
                        try {
                            const payloadObj = JSON.parse(packet.payload.toString());

                            // Error handling for Gen 2 devices
                            if (payloadObj?.error) {
                                this.adapter.log.error(`[MQTT] Received error message for ${this.getLogInfo()} - from "${payloadObj.src}": ${JSON.stringify(payloadObj.error)}`);
                            }

                            // Device Mode information (new)
                            if (payloadObj?.result?.profile) {
                                const newDeviceMode = payloadObj?.result?.profile;
                                if (newDeviceMode) {
                                    await this.setDeviceMode(newDeviceMode);
                                }
                            }

                        } catch (err) {
                            this.adapter.log.debug(`[MQTT] Error parsing command response: ${this.getLogInfo()} - topic: ${packet.topic}, error: ${err}`);
                        }
                    }

                    // Log debug messages for Gen 2 devices (if enabled in instance configuration)
                    if (packet.topic === `${this.mqttprefix}/debug/log`) {
                        if (this.adapter.config.logDebugMessages) {
                            this.adapter.log.info(`[Shelly Debug Message] ${this.getLogInfo()}: ${packet.payload.toString().trim()}`);
                        }
                    }
                }
            }

            this.createIoBrokerState(packet.topic, packet.payload);

            switch (packet.qos) {
                case 1:
                    try {
                        this.client.puback({ messageId: packet.messageId });
                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Client communication error (puback): ${this.getLogInfo()} - qos: ${packet.qos}, error: ${err}`);
                    }

                    break;
                case 2:
                    try {
                        this.client.pubrec({ messageId: packet.messageId });
                        this.resendState2Client('pubrec', packet.messageId);
                    } catch (err) {
                        this.adapter.log.debug(`[MQTT] Client communication error (pubrec): ${this.getLogInfo()} - qos: ${packet.qos}, error: ${err}`);
                    }

                    break;
                default:
                    break;
            }
        });

        // this.client pinged
        this.client.on('pingreq', () => {
            try {
                this.client.pingresp();
            } catch (err) {
                this.adapter.log.debug(`[MQTT] Client communication error (pingresp): ${this.getLogInfo()} - error: ${err}`);
            }
        });

        // response for QoS2
        this.client.on('pubrec', (packet) => {
            const qosmsg = this.getResendState2Client(packet.messageId);
            if (qosmsg && qosmsg.cmd === 'publish') {
                try {
                    this.client.pubrel({ messageId: packet.messageId });
                    this.resendState2Client('pubrel', packet.messageId);
                } catch (err) {
                    this.adapter.log.debug(`[MQTT] Client communication error (pubrel): ${this.getLogInfo()} - error: ${err}`);
                }
            } else {
                this.adapter.log.info(`[MQTT] Client ${this.getLogInfo()} received pubrec for unknown messageId: ${packet.messageId}`);
            }
        });

        // response for QoS2
        this.client.on('pubcomp', (packet) => {
            const qosmsg = this.getResendState2Client(packet.messageId);
            if (qosmsg && qosmsg.cmd === 'pubrec') {
                this.deleteResendState2Client(packet.messageId);
            } else {
                this.adapter.log.info(`[MQTT] Client ${this.getLogInfo()} received pubcomp for unknown messageId: ${packet.messageId}`);
            }
        });

        // response for QoS2
        this.client.on('pubrel', (packet) => {
            const qosmsg = this.getResendState2Client(packet.messageId);
            if (qosmsg && qosmsg.cmd === 'pubrec') {
                try {
                    this.deleteResendState2Client(packet.messageId);
                    this.client.pubcomp({ messageId: packet.messageId });
                } catch (err) {
                    this.adapter.log.debug(`[MQTT] Client communication error (pubcomp): ${this.getLogInfo()} - error: ${err}`);
                }
            } else {
                this.adapter.log.info(`[MQTT] Client ${this.getLogInfo()} received pubrel for unknown messageId: ${packet.messageId}`);
            }
        });

        // response for QoS1
        this.client.on('puback', (packet) => {
            // remove this message from queue
            const qosmsg = this.getResendState2Client(packet.messageId);
            if (qosmsg && qosmsg.cmd === 'publish') {
                this.deleteResendState2Client(packet.messageId);
            } else {
                this.adapter.log.info(`[MQTT] Client ${this.getLogInfo()} received puback for unknown messageId: ${packet.messageId}`);
            }
        });

        this.client.on('unsubscribe', (packet) => {
            this.adapter.log.debug(`[MQTT] Unsubscribe ${this.getLogInfo()}: ${JSON.stringify(packet)}`);

            try {
                this.client.unsuback({ messageId: packet.messageId });
            } catch (err) {
                this.adapter.log.debug(`[MQTT] Client communication error (unsuback): ${this.getLogInfo()} - error: ${err}`);
            }
        });

        // this.client subscribed
        this.client.on('subscribe', (packet) => {
            // send a suback with messageId and granted QoS level
            this.adapter.log.debug(`[MQTT] Subscribe ${this.getLogInfo()}: ${JSON.stringify(packet)}`);
            const granted = [];
            for (const i in packet.subscriptions) {
                granted.push(packet.subscriptions[i].qos);
            }
            if (packet.topic) {
                this.adapter.log.debug(`[MQTT] Subscribe topic ${this.getLogInfo()}: ${packet.topic}`);
            }

            try {
                this.client.suback({ granted: granted, messageId: packet.messageId });
            } catch (err) {
                this.adapter.log.debug(`[MQTT] Client communication error (suback): ${this.getLogInfo()} - error: ${err}`);
            }
        });
    }
}

class MQTTServer extends BaseServer {

    constructor(adapter, objectHelper, eventEmitter) {
        //if (!(this instanceof MQTTServer)) return new MQTTServer(adapter, objectHelper, eventEmitter);

        super(adapter, objectHelper, eventEmitter);

        this.server = new net.Server();
        this.clients = {};
    }

    listen() {
        this.server.on('connection', (stream) => {
            this.adapter.log.debug(`[MQTT Server] New connection from ${stream.remoteAddress}`);

            const client = new MQTTClient(this.adapter, this.objectHelper, this.eventEmitter, stream);
            this.clients[stream.remoteAddress] = client;

            stream.on('timeout', () => {
                this.adapter.log.debug(`[MQTT Server] Timeout for ${stream.remoteAddress} (${client.getLogInfo()})`);
                client.destroy();
                stream.destroy();
            });

            stream.on('unload', () => {
                this.adapter.log.debug(`[MQTT Server] Unload for ${stream.remoteAddress} (${client.getLogInfo()})`);
                client.destroy();
                stream.destroy();
            });

            stream.on('error', () => {
                this.adapter.log.debug(`[MQTT Server] Error for ${stream.remoteAddress} (${client.getLogInfo()})`);
                if (client) {
                    client.destroy();
                    stream.destroy();
                }
            });

            stream.on('close', () => {
                this.adapter.log.debug(`[MQTT Server] Close for ${stream.remoteAddress} (${client.getLogInfo()})`);
                delete this.clients[stream.remoteAddress];
            });

            stream.on('end', () => {
                this.adapter.log.debug(`[MQTT Server] End for ${stream.remoteAddress} (${client.getLogInfo()})`);
                stream.end();
            });
        });

        this.server.on('close', () => {
            this.adapter.log.debug(`[MQTT Server] Closing listener`);
        });

        this.server.on('error', (error) => {
            this.adapter.log.debug(`[MQTT Server] Error in listener: ${error}`);
        });

        this.server.listen(this.adapter.config.port, this.adapter.config.bind, () => {
            this.adapter.log.debug(`[MQTT Server] Started listener on ${this.adapter.config.bind}:${this.adapter.config.port}`);
        });
    }

    destroy() {
        super.destroy();
        this.adapter.log.debug(`[MQTT Server] Destroying`);

        for (const i in this.clients) {
            this.clients[i].destroy();
        }
        this.server.close();
    }
}

module.exports = {
    MQTTServer: MQTTServer
};
