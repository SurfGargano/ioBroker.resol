// @ts-nocheck
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

/*
 * Created with @iobroker/create-adapter v1.20.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
// Load modules here, e.g.:
const vbus = require('resol-vbus');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const adapterName = require('./package.json').name.split('.').pop();
const ipformat = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const fqdnformat = /^(?!:\/\/)(?=.{1,255}$)((.{1,63}\.){1,127}(?![0-9]*$)[a-z0-9-]+\.?)$/;
const serialformat = /^(COM|com)[0-9][0-9]?$|^\/dev\/tty.*$/;
const vbusioformat = /d[0-9]{10}.[vV][bB][uU][sS].[iInN][oOeE][tT]?/;
const distPath = './lib/resol-setup/';
const setupFileResolTypes = distPath + 'Setup-Resol-Types.js';
const actionPath = '.Actions.';
const ctx = {
    headerSet: vbus.HeaderSet(),
    hsc: vbus.HeaderSetConsolidator(),
    connection: vbus.Connection()
};
let jsoncontrollerSetupItems;
var myDeviceAddress;
var myDeviceID;


class resol extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({...options, name: adapterName});

        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('ready', this.onReady.bind(this));
    }

    //--- vbus write
    async runShot(context) {
        try {
            this.log.debug('Waiting for free bus...');
            const datagram = await context.connection.waitForFreeBus();
            context.masterAddress = datagram.sourceAddress;
            this.log.debug('Found master with address 0x' + context.masterAddress.toString(16));
            context.deviceAddress = context.masterAddress;

            const optimizer = await vbus.ConfigurationOptimizerFactory.createOptimizerByDeviceAddress(context.deviceAddress);
            context.optimizer = optimizer;
            if (!optimizer) {
                throw new Error('Unable to create optimizer for master with address 0x' + context.deviceAddress.toString(16));
            }
            context.customizer = new vbus.ConnectionCustomizer({
                deviceAddress: context.deviceAddress,
                connection: context.connection,
                optimizer: context.optimizer,
            });

            let savedConfig;
            if (context.saveConfig !== undefined) {
                const saveConfig = context.saveConfig;
                const oldConfig = context.oldConfig;
                const options = {
                    optimize: false,
                };
                this.log.debug('Start Optimizer');
                savedConfig = await context.customizer.saveConfiguration(saveConfig, oldConfig, options);
            } else {
                this.log.debug('Optimizer savedConfig = loadedConfig ', savedConfig);
            }
            this.log.debug('Save config ' + JSON.stringify(savedConfig));
            savedConfig.reduce((memo, value) => {
                if (!value.ignored) {
                    memo [value.valueId] = value.value;
                }
                return memo;
            }, {});
        } catch (e) {
            this.log.error('[runShot] Error: ' + e);
        } finally {
            this.log.debug('Finishing runshot ...');
        }
    }

    //--- end vbus write

    async loadJsonFile(filename) {
        const pathToFile = path.resolve(__dirname, filename);
        const fileContent = await new Promise((resolve, reject) => {
            fs.readFile(pathToFile, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
        return fileContent;
    }

    isNumber(n) {
        return /^-?[\d.]+(?:e-?\d+)?$/.test(n);
    }


    async getJSONByResolId(resolId) {
        let result;
        this.log.debug('[getJSONByResolId] given ResolID : ' + resolId);
        this.log.debug('[getJSONByResolId] Reading File: [' + setupFileResolTypes + ']');
        await this.loadJsonFile(setupFileResolTypes)
            .then((setupResolTypes) => {
                this.log.debug('[getJSONByResolId] Successfully read File. Content: [' + setupResolTypes + ']');
                const jsetupResolTypes = JSON.parse(setupResolTypes);
                this.log.debug('jsetupResolTypes : ' + JSON.stringify(jsetupResolTypes));
                jsetupResolTypes.forEach(item => {

                    if (resolId === item.id) {
                        result = item;
                    }
                });
                if (!result) this.log.warn('[getJSONByResolId] Controller type not found in setup file.');
                this.log.debug('[getJSONByResolId] result : ' + JSON.stringify(result));
            })
            .catch((err) => {
                this.log.error('[getJSONByResolId] Error: ' + err);
            });
        return result;
    }

    // generate all dp read from file
    async generateDP(resolAddr, resolId) {
        try {
            this.createOrExtendObject(resolId + '.Actions', {
                type: 'channel',
                common: {
                    name: 'These data fields trigger actions on your controller.',
                    type: 'string'
                },
                native: {}
            }, undefined);

            this.log.debug('[generateDP]->Resol-Address/Resol-ID:  [' + resolAddr + '] : [' + resolId + ']');
            const setupResolType = await this.getJSONByResolId(resolAddr);
            this.log.debug('[generateDP]->setupResolType: ' + JSON.stringify(setupResolType));
            const controllerSetupFile = distPath + setupResolType.setup + '.js';
            this.log.debug('[generateDP] Loading Controller-config-file: ' + controllerSetupFile);
            await this.loadJsonFile(controllerSetupFile)
                .then(controllerSetupItems => {
                    this.log.debug('[generateDP] Controller-config-file content: ' + JSON.stringify(controllerSetupItems));
                    jsoncontrollerSetupItems = JSON.parse(String(controllerSetupItems));
                    this.log.debug('[generateDP]->jsoncontrollerSetupItems: ' + JSON.stringify(jsoncontrollerSetupItems));
                    jsoncontrollerSetupItems.dp.forEach(item => {
                        this.log.debug('[generateDP]->item ' + JSON.stringify(item));
                        // create dp
                        let thisRole = 'value';
                        if (item.states) thisRole = 'indicator';

                        this.createOrExtendObject(resolId + actionPath + item.dpName, {
                            type: 'state',
                            common: {
                                name: item.dpName,
                                type: item.type,
                                min: item.min,
                                max: item.max,
                                states: item.states,
                                role: thisRole,
                                read: true,
                                write: true
                            },
                            native: {}
                        }, undefined);
                        this.subscribeStates(resolId + actionPath + item.dpName);
                    });
                })
                .catch(err => {
                    this.log.error('[generateDP] Controller-config-file (' + controllerSetupFile + ') load error: Please check if the file structure is valid.');
                    this.log.error('[generateDP] Controller-config-file load error: ' + err);
                });
        } catch (err) {
            this.log.error('[generateDP] Error: ' + err);
        } finally {
            this.log.debug('Finishing generateDP...');
        }
    }


    getDpFunction(dpName, Value) {
        try {
            const myDpNameArray = dpName.split('.');
            const len = myDpNameArray.length;
            // if the JSON was triggered
            if (len === 3) {
                if (myDpNameArray[len - 1] === 'JSON') {
                    return (Value);
                }
            }
            const myDpName = myDpNameArray[len - 1];
            let myfctItem;
            this.log.debug(JSON.stringify('getDpFunction jsoncontrollerSetupItems ' + jsoncontrollerSetupItems));
            jsoncontrollerSetupItems.fct.forEach(item => {
                this.log.debug('getDpFunction jsoncontrollerSetupItems->item ' + JSON.stringify(item));
                if (myDpName === item.name) {
                    myfctItem = item;
                }
            });
            // throw if error
            if (!myfctItem) {
                this.log.error('[getDpFunction] : fctItem not defined!');
                return;
            }
            let jsonValue;
            // easy way, only 1 cmd : {"valueId": "Handbetrieb1", "value": 0}
            if (myfctItem.cmd) {
                jsonValue = [];
                const jsonItem = {};
                jsonItem.valueId = myfctItem.cmd;
                jsonItem.value = Value;
                jsonValue.push(jsonItem);
            }
            // more then 1 cmd : [{"valueId": "ORueckkuehlung", "value": 0},{"valueId":"OHolyCool","value": 0}]
            if (myfctItem.cmds) {
                jsonValue = [];
                myfctItem.cmds.forEach(item => {
                    this.log.debug(JSON.stringify(item));
                    const jsonItem = {};
                    jsonItem.valueId = item.cmd;
                    jsonItem.value = Value;
                    jsonValue.push(jsonItem);
                });
            }
            this.log.debug(JSON.stringify(jsonValue));
            return jsonValue;
        } catch (e) {
            this.log.error('[getDpFunction] Error: ' + e);
        } finally {
            this.log.debug('Finishing Dpfunction...');
        }
    }


    searchForFctItem(thisName) {
        let result;
        jsoncontrollerSetupItems.fct.forEach(item => {
            if (item.name == thisName) {
                this.log.debug('fct->item found' + JSON.stringify(item));
                result = item;
            }
        });
        return result;
    }

    searchForDpItem(thisName) {
        let result;
        jsoncontrollerSetupItems.fct.forEach(item => {
            if (item.cmd == thisName) {
                this.log.debug('dp->item found' + JSON.stringify(item));
                result = item;
            }
        });
        return result;
    }

    getDpType (thisName) {
        let result;
        jsoncontrollerSetupItems.dp.forEach(item => {
            if (item.dpName==thisName) {
                this.log.debug('dp->Name found'+JSON.stringify(item)); 
                result=item.type;
            }
        });  
        return result; 
    }

    async loadMyConfig (context) {
        try{
            if (jsoncontrollerSetupItems) {          
                const optimizer = await vbus.ConfigurationOptimizerFactory.createOptimizerByDeviceAddress(context.deviceAddress);
                context.optimizer = optimizer;
                if (!optimizer) {
                    throw new Error('Unable to create optimizer for master with address 0x' + context.deviceAddress.toString(16));
                }
                context.customizer = new vbus.ConnectionCustomizer({
                    deviceAddress: context.deviceAddress,
                    connection: context.connection,
                    optimizer: context.optimizer,
                });

                let readConfig = [];

                jsoncontrollerSetupItems.dp.forEach(item => {
                    const fct = this.searchForFctItem(item.dpName);
                    if (fct.cmd) {
                        // generate readConfig                        
                        const thisConfig = {valueId: fct.cmd};
                        readConfig.push(thisConfig);
                    }
                });
                const options = {
                    optimize: !readConfig
                };
                const loadedConfig = await context.customizer.loadConfiguration(readConfig, options);
                this.log.debug('loadedConfig ' + JSON.stringify(loadedConfig));

                loadedConfig.forEach (item => {
                    let fctItem=this.searchForDpItem(item.valueId);
                    let thisDpName =  context.deviceID + actionPath + fctItem.name;
                    let thisType = this.getDpType (fctItem.name);
                    if (thisType == 'number') {
                       item.value = parseFloat(item.value); 
                    }
                    this.setStateAsync(thisDpName,item.value,true);
                });

                // read combined functions
                readConfig = [];
                for (const item of jsoncontrollerSetupItems.dp) {
                    const fctItem = this.searchForFctItem(item.dpName);
                    if (fctItem.cmds) {
                        console.log('fct->item ' + JSON.stringify(fctItem));
                        fctItem.cmds.forEach(item => {
                            const thisConfig = {valueId: item.cmd};
                            readConfig.push(thisConfig);
                        });

                        const loadedConfig = await context.customizer.loadConfiguration(readConfig, options);
                        this.log.debug('loadedConfig ' + JSON.stringify(loadedConfig));

                        // check if all items are numbers
                        let checkNumber = true;
                        loadedConfig.forEach(item => {
                            if (!this.isNumber(item.value)) checkNumber = false;
                        });
                        if (checkNumber) {
                            let thisValue = 1;
                            loadedConfig.forEach(item => {
                                thisValue &= item.value;
                            });
                            const thisDpName = context.deviceID + actionPath + fctItem.name;
                            this.setStateAsync(thisDpName, thisValue, true);
                        }
                    }
                }

            }
        } catch (e) {
            this.log.error(e);
        } finally {
            this.log.debug('Finishing loadMyConfig...');
        }
    }


    async onStateChange(id, state) {
        // Warning, state can be null if it was deleted
        if (state && !state.ack) {
            this.log.debug('Change on Object: ' + JSON.stringify(id));
            this.log.debug('State of Object: ' + JSON.stringify(state));
            this.log.debug('State :' + state.val);
            const value = JSON.parse(state.val);
            const myJSON = this.getDpFunction(id, value);
            this.log.debug('myJSON: ' + JSON.stringify(myJSON));
            const context = {connection: ctx.connection, deviceAddress: this.myDeviceAddress, saveConfig: myJSON};
            await this.runShot(context);
        }
    }


    async configIsValid(config) {
        this.log.debug('configIsValid Function ');
        this.log.debug('Entering Function [configIsValid]');
        // Log the current config given to the function
        this.log.debug(`Connection Type: ${this.config.connectionDevice}`);
        this.log.debug(`Connection Identifier: ${this.config.connectionIdentifier}`);
        this.log.debug(`Connection Port: ${this.config.connectionPort}`);
        this.log.debug(`VBus Password encrypted: ${this.config.vbusPassword}`);
        this.log.debug(`VBus Channel: ${this.config.vbusChannel}`);
        this.log.debug(`VBus Via Tag: ${this.config.vbusViaTag}`);
        this.log.debug(`VBus Interval: ${this.config.vbusInterval}`);
        return new Promise(
            function (resolve, reject) {
                // some helper functions
                function testSerialformat(config) {
                    if (!config.connectionIdentifier.match(serialformat)) {
                        reject('Serialformat is invalid! Please fix.');
                    }
                }

                function testIP_and_FQDN_Format(config) {
                    if (!config.connectionIdentifier.match(ipformat) && !config.connectionIdentifier.match(fqdnformat)) {
                        reject('[' + config.connectionIdentifier + '] is neither a valid IP-Format nor a fully qualified domain name (FQDN)!');
                    }
                }

                function testVBusIOFormat(config) {
                    if (!config.vbusViaTag.match(vbusioformat)) {
                        reject('VBusIO-Format is invalid! Should be something like [d01234567890.vbus.io] or [d01234567890.vbus.net].');
                    }
                }

                function testPassword(config) {
                    if (!config.vbusPassword || '' === config.vbusPassword) {
                        reject('Password is missing!');
                    }
                }

                function testPort(config) {
                    if ('' === config.connectionPort || 0 === config.connectionPort) {
                        reject('Invalid connection port given! Should be > 0.');
                    }
                }

                // switch connectionDevice seleted by User
                if (config.connectionDevice === 'serial') {
                    testSerialformat(config);
                    resolve('Config seems to be valid for USB/Serial.');
                } else if (config.connectionDevice === 'lan' || config.connectionDevice === 'langw') {
                    testIP_and_FQDN_Format(config);
                    testPassword(config);
                    testPort(config);
                    resolve('Config seems to be valid for LAN or LAN-Gateway.');
                } else if (config.connectionDevice === 'dl2' || config.connectionDevice === 'dl3') {
                    testIP_and_FQDN_Format(config);
                    testPort(config);
                    testPassword(config);
                    resolve('Config seems to be valid for KM2/DL2/DL3.');
                } else if (config.connectionDevice === 'inet') {
                    testPort(config);
                    testVBusIOFormat(config);
                    testPassword(config);
                    resolve('Config seems to be valid for KM2/DL2/DL3 via VBus.net.');
                } else {
                    reject('Config is invalid! Please select at least a connection device to get further tests - or even better, complete your whole config.');
                }
            }
        );
    }


    async main() {
        let relayActive = 'Relay X active';
        let language = 'en';

        try {
            // Get system language and set it for this adapter
            await this.getForeignObjectAsync('system.config').then(sysConf => {
                this.log.debug('Requesting language from system.');
                if (sysConf && (sysConf.common.language === 'de' || sysConf.common.language === 'fr')) {
                    // switch language to a language supported by Resol-Lib (de, fr), or default to english
                    language = sysConf.common.language;
                }
                this.log.debug('Requesting systemsecret from system.');
                if (sysConf && sysConf.native && sysConf.native.secret) {
                    this.config.vbusPassword = this.decrypt(sysConf.native.secret, this.config.vbusPassword);
                } else {
                    this.config.vbusPassword = this.decrypt('Zgfr56gFe87jJOM', this.config.vbusPassword);
                }
                // this line may be commented out by user for debugging purposes when assuming issues with password:
                // this.log.debug(`VBus Password decrypted: ${this.config.vbusPassword}`);

                // Set translation for relay active state
                switch (language) {
                    case 'de':
                        relayActive = 'Relais X aktiv';
                        break;
                    case 'fr':
                        relayActive = 'Relais X actif';
                        break;
                }
            }).catch(err => {
                this.log.error(JSON.stringify(err));
            });

            const spec = new vbus.Specification({
                language: language
            });

            // Set up connection depending on connection device and check connection identifier
            switch (this.config.connectionDevice) {
                case 'lan':
                    ctx.connection = new vbus.TcpConnection({
                        host: this.config.connectionIdentifier,
                        port: this.config.connectionPort,
                        password: this.config.vbusPassword
                    });
                    this.log.info('TCP Connection via LAN to [' + this.config.connectionIdentifier + ':' + this.config.connectionPort + '] selected');
                    break;

                case 'serial':
                    ctx.connection = new vbus.SerialConnection({
                        path: this.config.connectionIdentifier
                    });
                    this.log.info('Serial Connection at [' + this.config.connectionIdentifier + '] selected');
                    break;

                case 'langw':
                    ctx.connection = new vbus.TcpConnection({
                        host: this.config.connectionIdentifier,
                        port: this.config.connectionPort,
                        rawVBusDataOnly: this.config.vbusDataOnly
                    });
                    this.log.info('TCP Connection via LAN-gw to [' + this.config.connectionIdentifier + ':' + this.config.connectionPort + '] selected');
                    break;

                case 'inet':
                    this.log.debug('VBus.net Connection via [' + this.config.vbusViaTag.substring(12, this.config.vbusViaTag.length) + '] selected');
                    this.log.debug('VBus.net Connection via [' + this.config.vbusViaTag.substring(0, 11) + '] selected');
                    ctx.connection = new vbus.TcpConnection({
                        //host: this.config.connectionIdentifier,
                        host: this.config.vbusViaTag.substring(12, this.config.vbusViaTag.length),
                        port: this.config.connectionPort,
                        password: this.config.vbusPassword,
                        viaTag: this.config.vbusViaTag.substring(0, 11)
                    });
                    this.log.info('VBus.net Connection via [' + this.config.vbusViaTag + '] selected');
                    break;

                case 'dl2':
                    ctx.connection = new vbus.TcpConnection({
                        host: this.config.connectionIdentifier,
                        port: this.config.connectionPort,
                        password: this.config.vbusPassword
                    });
                    this.log.info('TCP Connection to KM2/DL2 on [' + this.config.connectionIdentifier + ':' + this.config.connectionPort + '] selected');
                    break;

                case 'dl3':
                    ctx.connection = new vbus.TcpConnection({
                        host: this.config.connectionIdentifier,
                        port: this.config.connectionPort,
                        password: this.config.vbusPassword,
                        channel: this.config.vbusChannel
                    });
                    this.log.info('TCP Connection to DL3 on [' + this.config.connectionIdentifier + ':' + this.config.connectionPort + '] selected');
            }

            // Connection state handler
            ctx.connection.on('connectionState', (connectionState) => {
                if (connectionState === 'CONNECTED') {
                    this.log.info('Connection established');
                    this.setStateAsync('info.connection', true, true);
                } else {
                    this.log.info('Connection state changed to ' + connectionState);
                    this.setStateAsync('info.connection', false, true);
                }
            });

            ctx.headerSet = new vbus.HeaderSet();
            let hasSettled = false;
            let settledCountdown = 0;

            // Packet handler
            ctx.connection.on('packet', (packet) => {
                if (!hasSettled) {
                    const headerCountBefore = ctx.headerSet.getHeaderCount();
                    ctx.headerSet.addHeader(packet);
                    ctx.hsc.addHeader(packet);
                    const headerCountAfter = ctx.headerSet.getHeaderCount();

                    if (headerCountBefore !== headerCountAfter) {
                        ctx.hsc.emit('headerSet', ctx.hsc);
                        settledCountdown = headerCountAfter * 2;
                    } else if (settledCountdown > 0) {
                        settledCountdown -= 1;
                    } else {
                        hasSettled = true;
                    }
                } else {
                    ctx.headerSet.addHeader(packet);
                    ctx.hsc.addHeader(packet);
                }
            });

            ctx.hsc = new vbus.HeaderSetConsolidator({
                interval: this.config.vbusInterval * 1000,
                timeToLive: (this.config.vbusInterval * 1000) + 1000
            });

            // HeaderSetConsolidator handler - creates object tree and updates values in preset interval
            ctx.hsc.on('headerSet', () => {
                const packetFields = spec.getPacketFieldsForHeaders(ctx.headerSet.getSortedHeaders());
                const data = _.map(packetFields, function (pf) {
                    return {
                        id: pf.id,
                        name: _.get(pf, ['packetFieldSpec', 'name', language]),
                        rawValue: pf.rawValue,
                        deviceName: pf.packetSpec.sourceDevice.fullName,
                        deviceId: pf.packetSpec.sourceDevice.deviceId.replace(/_/g, ''),
                        addressId: pf.packetSpec.sourceDevice.selfAddress,
                        unitId: pf.packetFieldSpec.type.unit.unitId,
                        unitText: pf.packetFieldSpec.type.unit.unitText,
                        typeId: pf.packetFieldSpec.type.typeId,
                        precision: pf.packetFieldSpec.type.precision,
                        rootTypeId: pf.packetFieldSpec.type.rootTypeId,
                        parts: pf.packetFieldSpec.parts,
                    };
                });

                this.log.debug('received data: ' + JSON.stringify(data));
                if (data[1]) {
                    // create device
                    this.createOrExtendObject(data[1].deviceId, {
                        type: 'device',
                        common: {
                            name: data[1].deviceName,
                            type: 'string'
                        },
                        native: {}
                    }, undefined);

                    // create channel
                    this.createOrExtendObject(data[1].deviceId + '.' + data[1].addressId, {
                        type: 'channel',
                        common: {
                            name: data[1].deviceId + '.' + data[1].addressId,
                            type: 'string'
                        },
                        native: {}
                    }, undefined);
                    // create write dps
                    if (!this.myDeviceAddress) {
                        this.myDeviceAddress = data[1].addressId;
                        this.log.debug('myDeviceAddress: ' + this.myDeviceAddress);
                        this.myDeviceID = data[1].deviceId;
                        this.generateDP(this.myDeviceAddress, this.myDeviceID);
                    }
                    const thisContext = {
                        connection: ctx.connection,
                        deviceAddress: this.myDeviceAddress,
                        deviceID: this.myDeviceID
                    };
                    this.loadMyConfig(thisContext);
                }
                // iterate over all data to create datapoints
                _.forEach(data, (item) => {
                    // this.log.debug('received item-data: ' + JSON.stringify(item));
                    const deviceId = item.deviceId.replace(/_/g, '');
                    const channelId = deviceId + '.' + item.addressId;
                    const objectId = channelId + '.' + item.id.replace(/_/g, '');
                    const isBitField = ((item.parts.length === 1) && (item.parts[0].mask !== 0xFF));
                    const isTimeField = ((item.rootTypeId === 'Time') || (item.rootTypeId === 'Weektime') || (item.rootTypeId === 'DateTime'));
                    const common = {
                        name: item.name,
                        type: 'number',
                        unit: item.unitText,
                        read: true,
                        write: false
                    };
                    let value;

                    if ((item.rawValue === undefined) || (item.rawValue === null)) {
                        value = 0;
                    } else if (item.rootTypeId === 'Number') {
                        value = parseFloat(item.rawValue.toFixed(item.precision));
                    } else if (item.rootTypeId === 'Time') {
                        value = spec.i18n.moment(item.rawValue * 60000).utc().format('HH:mm');
                    } else if (item.rootTypeId === 'Weektime') {
                        value = spec.i18n.moment((item.rawValue + 5760) * 60000).utc().format('dd,HH:mm');
                    } else if (item.rootTypeId === 'DateTime') {
                        value = spec.i18n.moment((item.rawValue + 978307200) * 1000).utc().format('L HH:mm:ss');
                    }

                    switch (item.unitId) {
                        case 'DegreesCelsius':
                            common.min = -100;
                            common.max = +1000;
                            common.role = 'value.temperature';
                            common.type = 'number';
                            break;
                        case 'Percent':
                            common.min = 0;
                            common.max = 100;
                            common.role = 'level.volume';
                            common.type = 'number';
                            // create Relay X active state (as far as we know these are the only percent-unit states )
                            this.createOrExtendObject(objectId + '_1', {
                                type: 'state',
                                common: {
                                    name: relayActive.replace('X', item.name.substr(item.name.length - 2).replace(' ', '')),
                                    type: 'boolean',
                                    role: 'indicator.activity',
                                    unit: '',
                                    read: true,
                                    write: false
                                }
                            }, (value > 0));
                            break;
                        case 'Hours':
                            common.role = 'value';
                            common.type = 'number';
                            break;
                        case 'WattHours':
                            common.role = 'value.power.generation';
                            common.type = 'number';
                            break;
                        case 'None':
                            if (!isBitField) {
                                if (isTimeField) {
                                    common.role = 'value';
                                    common.type = 'number';
                                } else {
                                    common.role = 'value';
                                }
                            } else {
                                common.role = 'indicator.maintenance.alarm';
                                common.type = 'boolean';
                                value = (value === 1);
                            }
                            break;
                        default:
                            common.role = 'value';
                            common.type = 'number';
                            break;
                    }
                    this.createOrExtendObject(objectId, {type: 'state', common}, value);
                });
            });
            // Establish connection             
            this.log.info('Wait for Connection...');
            await ctx.connection.connect();
            ctx.hsc.startTimer();

        } catch (error) {
            this.log.error(`[main()] error: ${error.message}, stack: ${error.stack}`);
        }
    }

    // Is called when databases are connected and adapter received configuration.
    async onReady() {
        try {
            // Terminate adapter after first start because configuration is not yet received
            // Adapter is restarted automatically when config page is closed
            await this.configIsValid(this.config)
                .then(result => {
                    this.log.info(result);
                    this.main();
                })
                .catch(err => {
                    this.log.error(err);
                    this.setStateAsync('info.connection', false);
                    this.terminate('Terminating Adapter until Configuration is completed', 11);
                });
        } catch (error) {
            this.log.error(`[onReady] error: ${error.message}, stack: ${error.stack}`);
        }
    }

    //  Create or extend object
    createOrExtendObject(id, objData, value) {
        const self = this;
        this.getObject(id, function (err, oldObj) {
            if (!err && oldObj) {
                self.extendObject(id, objData, () => {
                    if (typeof value !== 'undefined') self.setState(id, value, true);
                });
            } else {
                self.setObjectNotExists(id, objData, () => {
                    if (typeof value !== 'undefined') self.setState(id, value, true);
                });
            }
        });
    }

    // Decrypt passwords
    decrypt(key, value) {
        let result = '';
        for (let i = 0; i < value.length; ++i) {
            result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
        }
        return result;
    }

    // Exit adapter 
    onUnload(callback) {
        try {
            ctx.connection.disconnect();
            this.log.info('Cleaned up everything...');
            callback();
        } catch (e) {
            callback();
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new resol(options);
} else {
    // otherwise start the instance directly
    new resol();
}
