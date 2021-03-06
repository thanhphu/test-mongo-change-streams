'use strict';

const _ = require('lodash');
const async = require('async');

const redisClient = require('../db/redis');
const rdbController = require('./rdbController');

function listSensorsOnGateway(gatewayId, cb) {
  redisClient.hgetall('gateway:' + gatewayId, (err, reply) => {
    if (!err && reply.sensors) {
      cb(null, JSON.parse(reply.sensors));
    } else {
      cb(err, null);
    }
  });
}

function listSensorsOnDevice(deviceId, cb) {
  async.waterfall([
    // Get device's gateway
    function getDeviceGateway(next) {
      redisClient.hgetall('device:' + deviceId, (err, reply) => {
        if (!err && reply.owner) {
          next(null, reply.owner);
        } else {
          next(new Error('Device owner gateway not found ' + deviceId), null);
        }
      });
    },
    // Get gateway's sensors
    listSensorsOnGateway,
    // Filter sensors to keep only those match the device
    function filterSensorsBelongToDevice(sensors, next) {
      async.filter(
        sensors,
        (sensor, filterNext) => redisClient.hgetall('sensor:' + sensor, (err, sensorData) => {
          // Keep only sensors that match device ID
          filterNext(err, sensorData.deviceId === deviceId);
        }),
        next);
    }
  ], cb);
}


/**
 * Flatten a combination of gateways, devices and sensors into a sensor list
 * @param {*} devices
 * @param {*} gateways
 * @param {*} sensors
 * @param {*} cb
 */
function flattenIntoSensorList(devices, gateways, sensors, cb) {
  async.parallel([
    function convertDevicesToSensors (done) {
      async.map(
        devices,
        listSensorsOnDevice,
        (err, results) => {
          done(err, _.flatten(results));
        });
    },
    function convertGatewaysToSensors(done) {
      async.map(
        gateways,
        listSensorsOnGateway,
        (err, results) => {
          done(err, _.flatten(results));
        });
    },
    (done) => {
      done(null, sensors);
    }
  ], (err, results) => {
    if (!err) {
      let flattened = _.flatten(results);
      cb(err, flattened);
    } else {
      cb(err, null);
    }
  });
}

function sensorDeleted(sensorId) {
  rdbController.removeSensorFromLabels(sensorId);
  rdbController.removeSensorFromThings(sensorId);
}

function gatewayDeleted(gatewayId) {
  listSensorsOnGateway(gatewayId, (err, sensors) => {
    sensors.forEach((sensorId) => {
      sensorDeleted(sensorId);
    });
  });
}

/**
 * Add or update sensor, given sensor information in Redis and DB
 *
 * @param {*} sensorId stringActuator-gw_248800003151-TEMPCTRL
 * @param {*} sensorInfo Object {category: "actuator", name: "Aircon temperature control", delegateInfo: "{"realId":"stringActuator-gw_248800003151-TEMPCTRL…", sequence: "TEMPCTRL", type: "stringActuator", …}
 * @param {*} rdbSensorInfoArr Array[RowDataPacket {id_sensor: 96, mongo_id_sensor: "string-gw_248800000803-MODE", is_number: Buffer(1), …}]
 * @param {*} cb
 */
function addUpdateSensor(sensorId, sensorInfo, rdbSensorInfoArr, cb) {
  if (rdbSensorInfoArr && rdbSensorInfoArr.length === 1) {
    // Sensor exists
    let dbSensorInfo = rdbSensorInfoArr[0];
    if (dbSensorInfo.type !== sensorInfo.type) {
      // DB type and Redis type dosen't match
      rdbController.updateSensorType(dbSensorInfo.id_sensor, sensorInfo.type, cb); /* jshint ignore:line */
    } else {
      // Do nothing
      return cb && cb();
    }
  } else {
    // New sensor
    rdbController.createSensor(sensorId, null, sensorInfo.type, cb);
  }
}

function syncSensors(cb) {
  const SENSOR_TAG = 'sensor:';
  // Query all sensors from Redis
  redisClient.keys(SENSOR_TAG + '*', (errKeys, redisSensorList) => {
    async.each(
      redisSensorList,
      (sensorId, next) => {
        redisClient.hgetall(sensorId, (errHget, sensorInfo) => {
          // Get a sensor from Redis, extract its ID
          let mongoSensorId = sensorId.substring(SENSOR_TAG.length);
          rdbController.getSensors(mongoSensorId, (errDb, dbSensorInfo) => {
            // Got a sensor from RDB
            addUpdateSensor(mongoSensorId, sensorInfo, dbSensorInfo, next);
          });
        });
      },
      cb
    );
  });
}

module.exports.listSensorsOnGateway = listSensorsOnGateway;
module.exports.listSensorsOnDevice = listSensorsOnDevice;
module.exports.flattenIntoSensorList = flattenIntoSensorList;
module.exports.sensorDeleted = sensorDeleted;
module.exports.gatewayDeleted = gatewayDeleted;
module.exports.syncSensors = syncSensors;