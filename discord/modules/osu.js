const EventEmitter = require('events');
const path = require('path');
const async = require('async');
const jsonfile = require('jsonfile');
const request = require('request');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const config = require('../config');

const DATA_PATH = path.join(__dirname, 'osu-data.json');
const OSU_USER_URL = 'https://osu.ppy.sh/u/';
const TIMEZONE = 'America/Los_Angeles';

/**
 * osu-data.json
 * {
 *   "users": {
 *     <osu_id>: <last_online_timestamp>,
 *     ...
 *   },
 *   "channels": {
 *     <channel_id>: true,
 *     ...
 *   }
 * }
 */

function format(date, format = 'MM/DD HH:mm') {
  return moment.tz(date, TIMEZONE).format(format);
}

// TODO: Winston
function logErr(err) {
  return console.log(err);
}

const osuEmitter = new EventEmitter();
let osuTimer = null;
let stopTimer = false;

function startInterval(delay) {
  stopTimer = false;
  if (!osuTimer)
    (function _interval() {
      osuTimer = setTimeout(() => {
        updateLastActive((err, changes) => {
          if (!stopTimer) {
            osuEmitter.emit('update', err, changes);
            _interval();
          }
        });
      }, delay);
    })();
}

function stopInterval() {
  stopTimer = true;
  if (osuTimer) {
    clearTimeout(osuTimer);
    osuTimer = null;
  }
}

function getLastActive(id, cb) {
  request.get(`${OSU_USER_URL}${id}`, (err, res, body) => {
    if (err || !body)
      return cb(err || new Error('No response found.'));

    const $ = cheerio.load(body, {normalizeWhitespace: true});

    // <div class="profile-username">
    //   Pillowfication
    // </div>
    const username = $('.profile-username').text().trim();

    // <div title='Last Active'>
    //   <i class='icon-signout'></i>
    //   <div>
    //     <time class='timeago' datetime='2017-03-18T16:04:32Z'>2017-03-18 16:04:32 UTC</time>
    //   </div>                            ^^^^^^^^^^^^^^^^^^^^
    // </div>
    const date = $('div[title="Last Active"] time').attr('datetime');

    if (!username || !date)
      return cb(new Error('Error parsing response.'));

    cb(null, {
      username,
      date: moment(date).valueOf()
    });
  });
}

function updateLastActive(cb) {
  jsonfile.readFile(DATA_PATH, (err, prev) => {
    if (err)
      return cb(err);

    async.mapValuesLimit(prev.users, 20,
      (_, id, cb) => {
        getLastActive(id, (err, active) => {
          if (err)
            return cb(null, {err});

          cb(null, {
            username: active.username,
            date: active.date
          });
        });
      },
      (err, curr) => {
        const changes = [];
        for (const id in prev.users) {
          if (!curr[id].err && prev.users[id] && curr[id].date && curr[id].date > prev.users[id])
            changes.push({
              username: curr[id].username,
              date: curr[id].date
            });
          prev.users[id] = curr[id].date || prev.users[id];
        }

        // curr[id].err objects ignored

        jsonfile.writeFile(DATA_PATH, prev, {spaces: 2}, err => {
          cb(err, changes);
        });
      }
    );
  });
}

function addEntry(id, cb) {
  getLastActive(id, (err, active) => {
    if (err)
      return cb(err);

    jsonfile.readFile(DATA_PATH, (err, data) => {
      if (err)
        return cb(err);

      const date = active.date || 0;
      data.users[id] = date;

      jsonfile.writeFile(DATA_PATH, data, {spaces: 2}, err => {
        cb(err, {id, date});
      });
    });
  });
}

function deleteEntry(id, cb) {
  jsonfile.readFile(DATA_PATH, (err, data) => {
    if (err)
      return cb(err);

    delete data.users[id];

    jsonfile.writeFile(DATA_PATH, data, {spaces: 2}, err => {
      cb(err, id);
    });
  });
}

function addChannel(id, cb) {
  jsonfile.readFile(DATA_PATH, (err, data) => {
    if (err)
      return cb(err);

    data.channels[id] = true;

    jsonfile.writeFile(DATA_PATH, data, {spaces: 2}, err => {
      cb(err, id);
    });
  });
}

function deleteChannel(id, cb) {
  jsonfile.readFile(DATA_PATH, (err, data) => {
    if (err)
      return cb(err);

    delete data.channels[id];

    jsonfile.writeFile(DATA_PATH, data, {spaces: 2}, err => {
      cb(err, id);
    });
  });
}

module.exports = {
  init(bot) {
    try {
      jsonfile.readFileSync(DATA_PATH);
    } catch (e) {
      jsonfile.writeFileSync(DATA_PATH, {
        users: {},
        channels: {}
      }, {spaces: 2});
    }

    // Update data immediately without triggering a 'change' event
    updateLastActive(() => {});

    // Start the interval
    startInterval(3 * 60 * 1000);

    osuEmitter.on('update', (err, changes) => {
      if (err || !changes || !changes.length)
        return;

      jsonfile.readFile(DATA_PATH, (err, obj) => {
        if (err)
          { /* Do Nothing */ }

        for (const id in obj.channels) {
          const channel = bot.channels.get(id);
          if (channel)
            changes.forEach(change => {
              channel.sendMessage(
                `User \`${change.username}\` has come online (${format(change.date)}).`
              )
              .catch(logErr);
            });
        }
      });
    });

    bot.on('message', message => {
      if (message.author.bot)
        return;
      if (!config.admins.includes(message.author.id))
        return;

      if (/^p!osu/.test(message.content)) {
        const tokens = message.content.split(/\s+/);
        switch (tokens[1]) {
          case 'help':
          case 'h': {
            message.channel.sendCode('',
              'p!osu\n' +
              '  help            Print this message\n' +
              '  add <id>        Add a user to track\n' +
              '  remove <id>     Remove a user from tracking\n' +
              '  list            List all tracked users\n' +
              '  get [<id>]      Get a user\'s last tracked data\n' +
              '  update          Update all users\n' +
              '  bind            Bind the current channel to receive updates\n' +
              '  unbind          Unbind the current channel\n' +
              '  channels        List all bound channels\n' +
              '  start [<time>]  Start polling data with the specified interval\n' +
              '  stop            Stop polling data'
            );
          }
          break;

          case 'add': {
            const id = tokens[2];
            if (!id)
              message.channel.sendMessage(
                'No `id` specified. See `p!osu help` for more information.'
              ).catch(logErr);

            addEntry(id, (err, entry) => {
              message.channel.sendMessage(err
                ? `Error adding \`${entry.id}\`!`
                : `Added \`${entry.id}\` (${format(entry.date)}).`
              ).catch(logErr);
            });
          }
          break;

          case 'remove': {
            const id = tokens[2];
            if (!id)
              return message.channel.sendMessage(
                'No `id` specified. See `p!osu help` for more information.'
              ).catch(logErr);

            deleteEntry(id, (err, id) => {
              message.channel.sendMessage(err
                ? `Error removing \`${id}\`!`
                : `Removed \`${id}\`.`
              ).catch(logErr);
            });
          }
          break;

          case 'list': {
            jsonfile.readFile(DATA_PATH, (err, data) => {
              if (err)
                return message.channel.sendMessage(
                  'Error listing users!'
                ).catch(logErr);

              const users = Object.keys(data.users);
              message.channel.sendMessage(users.length
                ? `Users: ${users.map(user => `\`${user}\``).join(', ')}`
                : 'Users: (none)'
              ).catch(logErr);
            });
          }
          break;

          case 'get': {
            const id = tokens[2];

            if (id)
              jsonfile.readFile(DATA_PATH, (err, data) => {
                if (err)
                  return message.channel.sendMessage(
                    `Error getting user \`${id}\`!`
                  ).catch(logErr);

                message.channel.sendMessage(data.users[id] !== undefined
                  ? `User \`${id}\` (${format(data.users[id])} - ${moment(data.users[id]).fromNow()})`
                  : `User \`${id}\` is not being tracked.`
                ).catch(logErr);
              });

            else
              jsonfile.readFile(DATA_PATH, (err, data) => {
                if (err)
                  return message.channel.sendMessage(
                    'Error getting users!'
                  ).catch(logErr);

                const users = Object.keys(data.users);
                message.channel.sendMessage(users.length
                  ? `Users: ${users.map(id => `\`${id}\` (${format(data.users[id])})`).join(', ')}`
                  : 'Users: (none)'
                ).catch(logErr);
              });
          }
          break;

          case 'update': {
            const id = tokens[2];

            if (id)
              getLastActive(id, (err, active) => {
                if (err)
                  return message.channel.sendMessage(
                    `Error updating user \`${id}\`!`
                  ).catch(logErr);

                message.channel.sendMessage(
                  `User \`${active.username}\` updated (${format(active.date)} - ${moment(active.date).fromNow()}).`
                ).catch(logErr);
              });

            else
              updateLastActive((err, changes) => {
                if (err)
                  return message.channel.sendMessage(
                    'Error updating users!'
                  ).catch(logErr);

                message.channel.sendMessage(changes.length
                  ? 'Updated users:' +
                      changes.map(change => `\`${change.username}\` (${format(change.date)})`).join(', ')
                  : 'Updated users: (no changes).'
                ).catch(logErr);
              });
          }
          break;

          case 'bind': {
            const id = message.channel.id;
            addChannel(id, err => {
              if (err)
                return message.channel.sendMessage(
                  'Error binding channel!'
                ).catch(logErr);

              message.channel.sendMessage(
                `Channel \`${id}\` bound.`
              ).catch(logErr);
            });
          }
          break;

          case 'unbind': {
            const id = message.channel.id;
            deleteChannel(id, err => {
              if (err)
                return message.channel.sendMessage(
                  'Error unbinding channel!'
                ).catch(logErr);

              message.channel.sendMessage(
                `Channel \`${id}\` unbound.`
              ).catch(logErr);
            });
          }
          break;

          case 'channels': {
            jsonfile.readFile(DATA_PATH, (err, data) => {
              if (err)
                return message.channel.sendMessage(
                  'Error listing channels!'
                ).catch(logErr);

                const channels = Object.keys(data.channels);
                message.channel.sendMessage(channels.length
                  ? `Channels: ${channels.map(id => `\`${id}\``).join(', ')}`
                  : 'Channels: (none)'
                ).catch(logErr);
            });
          }
          break;

          case 'start': {
            const delay = +tokens[2] || 3 * 60 * 1000;
            startInterval(delay);
            message.channel.sendMessage(
              `Interval started with delay \`${delay}\``
            ).catch(logErr);
          }
          break;

          case 'stop': {
            stopInterval();
            message.channel.sendMessage(
              'Interval stopped'
            ).catch(logErr);
          }
          break;
        }
      }
    });
  }
};