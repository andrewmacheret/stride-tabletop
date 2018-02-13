"use strict";

const _ = require('lodash');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const cors = require('cors');
const jsonpath = require('jsonpath');
const Document = require('adf-builder').Document;
const prettyjson = require('prettyjson');
const ChessApi = require('./chess-api');

function prettify_json(data, options = {}) {
  return '{\n' + prettyjson.render(data, options) + '\n}';
}

const {PORT = 8000, STRIDE_CLIENT_ID, STRIDE_SECRET_ID, ENV = 'production'} = process.env;
if (!STRIDE_CLIENT_ID || !STRIDE_SECRET_ID) {
  console.error("Usage: PORT=<http port> STRIDE_CLIENT_ID=<app client ID> STRIDE_SECRET_ID=<app client secret> node app.js");
  process.exit(1);
}


const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static('.'));

/**
 * Simple library that wraps the Stride REST API
 */
const stride = require('./stride').factory({
  clientId: STRIDE_CLIENT_ID,
  clientSecret: STRIDE_SECRET_ID,
  env: ENV,
});


/**
 * This implementation doesn't make any assumption in terms of data store, frameworks used, etc.
 * It doesn't have proper persistence, everything is just stored in memory.
 */
const configStore = {};
const installationStore = {};


/**
 * Installation lifecycle
 * ----------------------
 * When a user installs or uninstalls your app in a conversation,
 * Stride makes a REST call to an endpoint specified in the app descriptor:
 *       "lifecycle": {
 *           "installed": "/some/url",
 *           "uninstalled": "/some/url"
 *       }
 * At installation, Stride sends the context of the installation: cloudId, conversationId, userId
 * You can store this information for later use.
 */
app.post('/installed', (req, res, next) => {
  console.log('- app installed in a conversation');
  const cloudId = req.body.cloudId;
  const userId = req.body.userId;
  const conversationId = req.body.resourceId;

  // Store the installation details
  if (!installationStore[conversationId]) {
    installationStore[conversationId] = {
      cloudId,
      conversationId,
      installedBy: userId,
    }
    console.log('  App installed in this conversation:', prettify_json(installationStore[conversationId]));
  }
  else
    console.log('  App already installed in conversation:', prettify_json(installationStore[conversationId]));


  // Send a message to the conversation to announce the app is ready
  stride.sendTextMessage({
      cloudId,
      conversationId,
      text: "Hi there! Thanks for adding me to this conversation. To see me in action, just mention me in a message.",
    })
    .then(() => res.sendStatus(200))
    .catch(next);
});

app.post('/uninstalled', (req, res) => {
  console.log('- app uninstalled from a conversation');
  const conversationId = req.body.resourceId;

  // note: we can't send message in the room anymore

  // Remove the installation details
  installationStore[conversationId] = null;

  res.sendStatus(204);
});


/**
 * chat:bot
 * --------
 * This function is called anytime a user mentions the bot in a conversation.
 * You first need to declare the bot in the app descriptor:
 * "chat:bot": [
 *   {
 *     "key": "refapp-bot",
 *     "mention": {
 *      "url": "https://740a1ad5.ngrok.io/bot-mention"
 *     }
 *   }
 * ]
 *
 */

 app.post('/bot-mention',
  stride.validateJWT,
  (req, res, next) => {
    const reqBody = req.body
    const host = req.headers.host
    reqBody.host = host
    console.log('- bot mention', prettify_json(reqBody))

    Promise.all([
      res.sendStatus(200),
      gameBot({reqBody})
    ]).then(() => {
      console.log('  SUCCESS!')
    }).catch(err => {
      console.error('  Something went wrong', prettify_json(err))
      replyWithMessage(reqBody, ':warning:', err.message || err)
    })
  }
)

class GameStore {
  constructor() {
    this.gameData = new Map() // by id
    this.games = new Map() // cloudId:conversationId:playerId:gameName -> game_id
  }

  getGameIds({cloudId, conversationId, gameName, playerIds}) {
    if (!cloudId) throw new Error('cloudId not specified')
    if (!conversationId) throw new Error('conversationId not specified')
    if (!playerIds || playerIds.length < 1) throw new Error('playerIds must have at least one player id')
    if (!gameName) gameName = '_all'

    const playerIdsCombined = playerIds.sort().join(',')

    const set = this.games.get(`${cloudId}:${conversationId}:${playerIdsCombined}:${gameName}`)
    const result = set ? [...set.values()] : []
    console.log(`getGameIds(${cloudId}:${conversationId}:${playerIdsCombined}:${gameName}) == ${result}`)
    return result
  }

  getGameData(game_id) {
    return this.gameData.get(game_id)
  }

  addGame({cloudId, conversationId, gameName, playerIds, game}) {
    if (!cloudId) throw new Error('cloudId not specified')
    if (!conversationId) throw new Error('cloudId not specified')
    if (!playerIds || playerIds.length < 1) throw new Error('playerIds must have at least one player id')
    if (!gameName) throw new Error('gameName not specified')

    const playerIdsCombined = playerIds.sort().join(',')

    const gameId = game.game_id
    this.gameData.set(gameId, game)

    this.addToValues(`${cloudId}:${conversationId}:${playerIdsCombined}:_all`, gameId)
    this.addToValues(`${cloudId}:${conversationId}:${playerIdsCombined}:${gameName}`, gameId)

    playerIds.forEach(playerId => {
      this.addToValues(`${cloudId}:${conversationId}:${playerId}:_all`, gameId)
      this.addToValues(`${cloudId}:${conversationId}:${playerId}:${gameName}`, gameId)
    })
  }

  removeGame({cloudId, conversationId, gameName, playerIds, gameId}) {
    if (!cloudId) throw new Error('cloudId not specified')
    if (!conversationId) throw new Error('cloudId not specified')
    if (!playerIds || playerIds.length < 1) throw new Error('playerIds must have at least one player id')
    if (!gameName) throw new Error('gameName not specified')

    const playerIdsCombined = playerIds.sort().join(',')

    this.gameData.delete(gameId)

    this.removeFromValues(`${cloudId}:${conversationId}:${playerIdsCombined}:_all`, gameId)
    this.removeFromValues(`${cloudId}:${conversationId}:${playerIdsCombined}:${gameName}`, gameId)

    playerIds.forEach(playerId => {
      this.removeFromValues(`${cloudId}:${conversationId}:${playerId}:_all`, gameId)
      this.removeFromValues(`${cloudId}:${conversationId}:${playerId}:${gameName}`, gameId)
    })
  }

  addToValues(key, value) {
    console.log(`adding ${key} = ${value}`)
    let set = this.games.get(key)
    if (!set) {
      this.games.set(key, set = new Set())
    }
    set.add(value)
  }

  removeFromValues(key, value) {
    console.log(`deleting ${key} = ${value}`)
    let set = this.games.get(key)
    if (!this.games.has(key)) {
      return
    }
    set.delete(value)
    if (set.size === 0) {
      this.games.delete(key)
    }
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const BOT_NAME = '@Tabletop'

const gameStore = new GameStore()

async function gameBot({reqBody}) {
  const cloudId = reqBody.cloudId;
  const conversationId = reqBody.conversation.id;
  const senderId = reqBody.sender.id;
  //const messageId = reqBody.message.id;
  //let user;

  return await processInput()

  async function processInput() {
    const command = extractCommand()
    if (command) {
      let gameName = command.gameName
      let players = await extractPlayers()
      const sender = players[players.length - 1]
      if (command.action === 'start') {
        if (!command.opponent.isHuman && players.length === 1) {
          players.push({id: '_none', text: 'AI'})
        }

        if (players.length === 2) {

          const playerIds = players.map(player => player.id)
          let gameIds = gameStore.getGameIds({cloudId, conversationId, gameName, playerIds})
          if (gameIds.length > 0) {
            return await replyWithMessage(reqBody, ':disapproval:', `Game already exists.`)
          }

          shuffle(players)
          const playerContacts = players.map(player => `stride:${player.id}:${player.text}`)

          const game = await ChessApi.createGame(playerContacts)

          const board = await replyOnBoard(game, players)
          game.message_id = board.id

          gameStore.addGame({cloudId, conversationId, gameName, playerIds, game})

          return await promptNextMove(game, gameName, players)
        }
      } else if (command.action === 'move') {
        if (command.opponent && !command.opponent.isHuman) {
          players.push({id: '_none', text: 'AI'})
        }

        let playerIds = players.map(player => player.id)
        let gameIds = gameStore.getGameIds({cloudId, conversationId, gameName, playerIds})
        if (gameIds.length === 0) {
          return await replyWithMessage(reqBody, ':disapproval:', `Game not found.\nTo start a new game:\n'${BOT_NAME} play chess with @someone'.`)
        } else if (gameIds.length > 1) {
          return await replyWithMessage(reqBody, ':disapproval:', `Too many games found. Please specify which game by mentioning the other @player.`)
        }
        const gameId = gameIds[0]
        const game = gameStore.getGameData(gameId)
        if (!gameName) {
          //TODO: gameName = game.rules
          gameName = 'chess'
        }

        // go from player indexes to player objects' contacts
        // then split the contacts by ':'
        // expecting format 'stride:5a430b108111c32c4340fc8f:@someone'
        // expecting format 'stride:123456~5a430b108111c32c4340fc8f:@someone'
        const nextPlayerContacts = game.current_game_state.state.next_players.map(player_number => game.game_players[player_number].contact.split(':', 3))
          .filter(contact => contact[0] === 'stride')
        if (nextPlayerContacts.map(contact => contact[1]).indexOf(senderId.replace(/:/g, '~')) < 0) {
          return await replyWithMessage(reqBody, ':disapproval:', `It's not your turn.`)
        }
        players = game.game_players.map(game_player => {
          const split = game_player.contact.split(':', 3)
          return { id: split[1], text: split[2] }
        })
        playerIds = players.map(player => player.id)
        console.log('PLAYER_IDS=', playerIds)

        const gameState = await ChessApi.performMove(game, command.move)

        const board = await replyOnBoard(game, players, game.message_id)
        game.message_id = board.id

        if (game.current_game_state.state.game_over) {
          gameStore.removeGame({cloudId, conversationId, gameName, playerIds, gameId})

          return await replyWithMessage(reqBody, ':checkered_flag:', game.current_game_state.state.message)
        }

        return await promptNextMove(game, gameName, players)
      }
    }

    return await replyWithUsage()
  }

  async function promptNextMove(game, gameName, players) {
    const nextPlayers = game.current_game_state.state.next_players.map(player_number =>
      game.game_players[player_number].contact.split(':', 3)
    ).filter(contact =>
      contact[0] === 'stride'
    ).map(contact => ({
      id: contact[1],
      text: contact[2]
    }))

    const nextPlayersAI = nextPlayers.filter(contact => contact.id === '_none')
    const nextPlayersHuman = nextPlayers.filter(contact => contact.id !== '_none')

    const promises = []
    if (nextPlayersHuman.length > 0) {
      promises.push(replyWithMessage(reqBody, 'Your move: ', ...nextPlayersHuman))
    }
    if (nextPlayersAI.length > 0) {
      promises.push(performAIMove(game, gameName, players))
    }

    return await Promise.all(promises)
  }

  async function performAIMove(game, gameName, players) {
    const newGameState = await ChessApi.performAIMove(game)

    const board = await replyOnBoard(game, players, game.message_id)
    game.message_id = board.id

    if (game.current_game_state.state.game_over) {
      const playerIds = players.map(player => player.id)
      gameStore.removeGame({cloudId, conversationId, gameName, playerIds, gameId: game.game_id})

      return await replyWithMessage(reqBody, ':checkered_flag:', game.current_game_state.state.message)
    }

    return await promptNextMove(game, gameName, players)
  }

  async function replyWithUsage() {
    const usage = [
      ':information_source:',
      `\nUsage:\n`,
      `\t${BOT_NAME} play <game> [ with ] { @opponent | AI }\n`,
      `\t${BOT_NAME} [ <game> ] [ @opponent ] <move>\n`,
      `Examples:\n`,
      `\t${BOT_NAME} play chess with @opponent\n`,
      `\t${BOT_NAME} play chess with AI\n`,
      `\t${BOT_NAME} e4\n`,
      `\t${BOT_NAME} dxe8=Q+\n`,
      `\t${BOT_NAME} Nbxc6#\n`,
      `\t${BOT_NAME} forfeit\n`,
      `Supported games: 'chess' (more to come...)\n`,
      `Chess moves are in:\n\t`,
      {description: 'Standard Algebraic Notation (SAN)', link: 'https://en.wikipedia.org/wiki/Algebraic_notation_(chess)'}
    ]
    return await replyWithMessage(reqBody, ...usage)
  }

  async function extractPlayers() {
    const players = jsonpath.query(reqBody, '$..[?(@.type == "mention")]')
      .filter(node => node.attrs.text !== BOT_NAME)
      .map(node => ({id: node.attrs.id.replace(/:/g, '~'), text: node.attrs.text}))

    players.push({
      id: senderId.replace(/:/g, '~'),
      text: (await stride.getUser({cloudId, userId: senderId})).displayName
    })

    console.log('PLAYERS=', players)
    return players
  }

  function extractCommand() {
    const commands = jsonpath.query(reqBody, '$..[?(@.type == "text")]')
      .map(node => node.text)
      .join(' ')
      .split(/ +/)
      .map(text => text.trim())
      .filter(text => text.length > 0)

    const playWords = new Set()
    playWords.add('play')
    playWords.add('start')
    playWords.add('begin')
    playWords.add('create')

    const withWords = new Set()
    withWords.add('with')
    withWords.add('vs')
    withWords.add('vs.')
    withWords.add('versus')
    withWords.add('against')

    const aiWords = new Set()
    aiWords.add('ai')
    aiWords.add('computer')
    aiWords.add('machine')
    aiWords.add('you')

    console.log('COMMANDS=', commands)
    
    // play game [with] AI
    if (
      (commands.length === 3 && playWords.has(commands[0].toLowerCase()) && aiWords.has(commands[2].toLowerCase())) ||
      (commands.length === 4 && playWords.has(commands[0].toLowerCase()) && withWords.has(commands[2].toLowerCase()) && aiWords.has(commands[3].toLowerCase()))) {
      // TODO support non-chess
      const gameName = commands[1].toLowerCase()
      if (!gameName) {
        gameName = 'chess'
      } else if (gameName !== 'chess') {
        return null
      }

      const action = 'start'
      
      return {action, gameName, opponent: {isHuman: false}}
    }

    // play game [with] @someone
    if ((commands.length === 2 && playWords.has(commands[0].toLowerCase())) || (commands.length === 3 && playWords.has(commands[0].toLowerCase()) && withWords.has(commands[2].toLowerCase()))) {
      // TODO support non-chess
      const gameName = commands[1].toLowerCase()
      if (!gameName) {
        gameName = 'chess'
      } else if (gameName !== 'chess') {
        return null
      }

      const action = 'start'
      
      return {action, gameName, opponent: {isHuman: true}}
    }

    // AI

    // make a move on an existing game
    // @someone game AI e4
    if (commands.length === 3 && aiWords.has(commands[1].toLowerCase())) {
      
      // TODO support non-chess!!!
      const gameName = commands[0].toLowerCase()
      if (!gameName) {
        gameName = 'chess'
      } else if (gameName !== 'chess') {
        return null
      }

      const move = commands[2]
      if (!move) {
        return null
      }
      
      const action = 'move'
      
      return {action, gameName, move, opponent: {isHuman: false}}
    }

    // make a move on an existing game
    // @someone AI e4
    if (commands.length === 2 && aiWords.has(commands[0].toLowerCase())) {
      const move = commands[1]
      if (!move) {
        return null
      }
      
      const action = 'move'
      
      return {action, move, opponent: {isHuman: false}}
    }

    // make a move on an existing game
    // @someone game e4
    if (commands.length === 2) {
      
      // TODO support non-chess!!!
      const gameName = commands[0].toLowerCase()
      if (!gameName) {
        gameName = 'chess'
      } else if (gameName !== 'chess') {
        return null
      }

      const move = commands[1]
      if (!move) {
        return null
      }
      
      const action = 'move'
      
      return {action, gameName, move}
    }

    // make a move on an existing game
    // @someone e4
    if (commands.length === 1) {
      
      const move = commands[0]
      if (!move) {
        return null
      }
      
      const action = 'move'
      
      return {action, move}
    }

    return null
  }

  async function replyOnBoard(game, players, messageId=null) {
    // TODO: convert fen to a real board
    const fen = game.current_game_state.state.fen

    const doc = new Document()
    let paragraph = doc.paragraph()
    paragraph = players[0].id === '_none' ? paragraph.text(players[0].text) : paragraph.mention(players[0].id.replace(/~/g, ':'), players[0].text)
    paragraph = paragraph.text('  vs  ')
    paragraph = players[1].id === '_none' ? paragraph.text(players[1].text) : paragraph.mention(players[1].id.replace(/~/g, ':'), players[1].text)
    paragraph = paragraph.text('\t\t')
    paragraph = paragraph.text(game.current_game_state.state.message)
    doc.codeBlock('javascript')
      .text(renderBoard(fen))
    const document = doc.toJSON();

    if (messageId) {
      return await stride.updateMessage({cloudId, conversationId, messageId, document})
    } else {
      return await stride.reply({reqBody, document})
    }
  }

  function renderBoard(fen) {
    const pieceMap = {
      'p': '♟',
      'r': '♜',
      'n': '♞',
      'b': '♝',
      'k': '♚',
      'q': '♛',
      'P': '♙',
      'R': '♖',
      'N': '♘',
      'B': '♗',
      'K': '♔',
      'Q': '♕',
      '.': '.'
    }
    const letters = '    a b c d e f g h    '
    const border = '  +-----------------+  '
    return letters + '\n' + border + '\n' + fen.split(' ')[0]
      .replace(/1/g, '.'.repeat(1))
      .replace(/2/g, '.'.repeat(2))
      .replace(/3/g, '.'.repeat(3))
      .replace(/4/g, '.'.repeat(4))
      .replace(/5/g, '.'.repeat(5))
      .replace(/6/g, '.'.repeat(6))
      .replace(/7/g, '.'.repeat(7))
      .replace(/8/g, '.'.repeat(8))
      .split('/')
      .map((row, i) => (8-i) + ' | ' + row.split('').map(ch => pieceMap[ch]).join(' ') + ' | ' + (8-i))
      .join('\n') + '\n' + border + '\n' + letters
  }
}

async function replyWithMessage(reqBody, ...objects) {
  const doc = new Document()
  let paragraph = doc.paragraph()
  
  objects.forEach(object => {
    if (typeof object === 'string') {
      if (object === '\n') {
        paragraph = doc.paragraph()
      } else if (object[0] === ':' && object[object.length-1] === ':') {
        paragraph = paragraph.text('  ')
        paragraph = paragraph.emoji(object)
        paragraph = paragraph.text('  ')
      } else {
        paragraph = paragraph.text(object)
      }
    } else if (object.link) {
      paragraph = paragraph.link(object.description, object.link)
    } else {
      paragraph = paragraph.mention(object.id.replace(/~/g, ':'), object.text)
    }
  })
  
  const document = doc.toJSON()

  return await stride.reply({reqBody, document})
}

/*
    a b c d e f g h
  +-----------------+
8 | ♜ ♞ ♝ ♛ . ♝ ♞ ♜ | 8
7 | ♟ . . ♟ ♚ . ♟ ♟ | 7
6 | ♟ . ♟ . . ♟ . . | 6
5 | . . . . ♟ . . ♕ | 5
4 | . . . . ♗ . . . | 4
3 | ♗ . ♗ . . . . . | 3
2 | . ♗ . ♗ . ♗ ♗ ♗ | 2
1 | ♖ ♘ ♗ . ♔ . ♘ ♖ | 1
  +-----------------+
    a b c d e f g h
*/



/**
 * core:webhook
 *
 * Your app can listen to specific events, like users joining/leaving conversations, or conversations being created/updated
 * Note: webhooks will only fire for conversations your app is authorized to access
 */

app.post('/conversation-updated',
  stride.validateJWT,
  (req, res) => {
    console.log('A conversation was changed: ' + req.body.conversation.id + ', change: ' + prettify_json(req.body.action));
    res.sendStatus(200);
  }
);

app.post('/roster-updated',
  stride.validateJWT,
  (req, res) => {
    console.log('A user joined or left a conversation: ' + req.body.conversation.id + ', change: ' + prettify_json(req.body.action));
    res.sendStatus(200);
  }
);

/**
 * chat:configuration
 * ------------------
 * Your app can expose a configuration page in a dialog inside the Stride app. You first declare it in the descriptor:
 * TBD
 */

app.get('/module/config',
  stride.validateJWT,
  (req, res) => {
    res.redirect("/app-module-config.html");
  }
);

// Get the configuration state: is it configured or not for the conversation?
app.get('/module/config/state',
  // cross domain request
  cors(),
  stride.validateJWT,
  (req, res) => {
    const conversationId = res.locals.context.conversationId;
    console.log("getting config state for conversation " + conversationId);
    const config = configStore[res.locals.context.conversationId];
    const state = {configured: true};
    if (!config)
      state.configured = false;
    console.log("returning config state: " + prettify_json(state));
    res.send(JSON.stringify(state));
  }
);

// Get the configuration content from the configuration dialog
app.get('/module/config/content',
  stride.validateJWT,
  (req, res) => {
    const conversationId = res.locals.context.conversationId;
    console.log("getting config content for conversation " + conversationId);
    const config = configStore[res.locals.context.conversationId] || {notificationLevel: "NONE"};
    res.send(JSON.stringify(config));
  }
);

// Save the configuration content from the configuration dialog
app.post('/module/config/content',
  stride.validateJWT,
  (req, res, next) => {
    const cloudId = res.locals.context.cloudId;
    const conversationId = res.locals.context.conversationId;
    console.log("saving config content for conversation " + conversationId + ": " + prettify_json(req.body));
    configStore[conversationId] = req.body;

    stride.updateConfigurationState({cloudId, conversationId, configKey: 'refapp-config', state: true})
      .then(() => res.sendStatus(204))
      .catch(next);
  }
);

app.get('/module/dialog',
  stride.validateJWT,
  (req, res) => {
    res.redirect("/app-module-dialog.html");
  }
);

/**
 * chat:glance
 * ------------
 * To contribute a chat:glance to the Stride right sidebar, declare it in the app descriptor
 *  "chat:glance": [
 * {
 *   "key": "refapp-glance",
 *  "name": {
 *     "value": "App Glance"
 *   },
 *   "icon": {
 *     "url": "/icon.png",
 *     "url@2x": "/icon.png"
 *   },
 *   "target": "refapp-sidebar",
 *   "queryUrl": "/module/glance/state"
 * }
 * ]
 * This adds a glance to the sidebar. When the user clicks on it, Stride opens the module whose key is specified in "target".
 *
 * When a user first opens a Stride conversation where the app is installed,
 * the Stride app makes a REST call to the queryURL to get the initial value for the glance.
 * You can then update the glance for a conversation at any time by making a REST call to Stride.
 * Stride will then make sure glances are updated for all connected Stride users.
 **/

app.get('/module/glance/state',
  // cross domain request
  cors(),
  stride.validateJWT,
  (req, res) => {
    res.send(
      JSON.stringify({
        "label": {
          "value": "Click me!"
        }
      }));
  }
);

/*
 * chat:sidebar
 * ------------
 * When a user clicks on the glance, Stride opens an iframe in the sidebar, and loads a page from your app,
 * from the URL specified in the app descriptor
 * 		"chat:sidebar": [
 * 		 {
 * 		    "key": "refapp-sidebar",
 * 		    "name": {
 * 		      "value": "App Sidebar"
 * 		    },
 * 		    "url": "/module/sidebar",
 * 		    "authentication": "jwt"
 * 		  }
 * 		]
 **/

app.get('/module/sidebar',
  stride.validateJWT,
  (req, res) => {
    res.redirect("/app-module-sidebar.html");
  }
);

/**
 * Making a call from the app front-end to the app back-end:
 * You can find the context for the request (cloudId, conversationId) in the JWT token
 */

app.post('/ui/ping',
  stride.validateJWT,
  (req, res) => {
    console.log('Received a call from the app frontend ' + prettify_json(req.body));
    const cloudId = res.locals.context.cloudId;
    const conversationId = res.locals.context.conversationId;
    stride.sendTextMessage({cloudId, conversationId, text: "Pong"})
      .then(() => res.send(JSON.stringify({status: "Pong"})))
      .catch(() => res.send(JSON.stringify({status: "Failed"})))
  }
);


/**
 * Your app has a descriptor (app-descriptor.json), which tells Stride about the modules it uses.
 *
 * The variable ${host} is substituted based on the base URL of your app.
 */

app.get('/descriptor', (req, res) => {
  fs.readFile('./app-descriptor.json', (err, descriptorTemplate) => {
    const template = _.template(descriptorTemplate);
    const descriptor = template({
      host: 'https://' + req.headers.host
    });
    res.set('Content-Type', 'application/json');
    res.send(descriptor);
  });
});


app.use(function errorHandler(err, req, res, next) {
  if (!err) err = new Error('unknown error')
  console.error({err}, 'app error handler: request failed!');
  const status = err.httpStatusHint || 500;
  res.status(status).send(`Something broke! Our devs are already on it! [${status}: ${http.STATUS_CODES[status]}]`);
  process.exit(1) // XXX DEBUG
});


/**
 * Handling when a user clicks on a button in a card. The service is declared in the app descriptor
 * ("chat:actionTarget", with a target type of "callService" which refers to this endpoint).
 * In this case, the card is updated with a message which only the user who clicked the action can see,
 * and a follow up action is triggered (opening a sidebar, dialog, etc.)
 */

app.options('/module/action/refapp-service', cors());
app.post('/module/action/refapp-service',
  cors(),
  stride.validateJWT,
  (req, res) => {
    console.log('Received a call from an action in a message' + prettify_json(req.body));
    const cloudId = res.locals.context.cloudId;
    const conversationId = res.locals.context.conversationId;
    const parameters = req.body.parameters;
    var response = {
    };
    if(parameters.returnError) {
      response.error = "Things failed because of some reason"
    } else {
      response.message = "Done!"
    }

    if (req.body.parameters) {
      if (parameters.then) {
        if (parameters.then === 'open sidebar') {
          response.nextAction = {
            target: {
              key: "refapp-action-openSidebar"
            }
          }
        }
        if (parameters.then === 'open dialog') {
          response.nextAction = {
            target: {
              openDialog: {
                key: "refapp-dialog"
              }
            }
          }
        }
        if (parameters.then === 'open conversation') {
          response.nextAction = {
            target: {
              openConversation: {
                conversationId: parameters.conversationId
              }
            }
          }
        }
        if (parameters.then === 'open highlights') {
          response.nextAction = {
            target: {
              openHighlights: {}
            }
          }
        }
        if (parameters.then === 'open files and links') {
          response.nextAction = {
            target: {
              openFilesAndLinks: {}
            }
          }
        }
      }
    }
    if(parameters.returnError) {
      res.status(403);
    }
    res.send(JSON.stringify(response));

    stride.sendTextMessage({
        cloudId, conversationId,
        text: "A button was clicked! The following parameters were passed: " + JSON.stringify(parameters)
      })
      .then(() => res.send(JSON.stringify({})));
  }
);

/**
 * Handling when a user clicks on an action in a card, and replace the original message with another one.
 */

app.options('/module/action/refapp-service-updateMessage', cors());
app.post('/module/action/refapp-service-updateMessage',
  cors(),
  stride.validateJWT,
  (req, res) => {
    console.log('Received a call from an action in a message' + prettify_json(req.body));
    const cloudId = res.locals.context.cloudId;
    const conversationId = res.locals.context.conversationId;
    const parameters = req.body.parameters;
    console.log(JSON.stringify(req.body))
    const messageId = req.body.context.message.mid;

    const doc = new Document();

    const card = doc.applicationCard('Incident #4253')
      .link('https://www.atlassian.com')
      .description('Something is broken')
    if(parameters.incidentAction === "ack") {
      card.detail()
        .title('Status')
        .text('In progress')
      card.detail()
        .title('Assigned to')
        .text('Joe Blog')
      card.action()
        .title("Resolve")
        .target({key: "refapp-action-callService-updateMessage"})
        .parameters({incidentAction: "resolve"})
    }
    if(parameters.incidentAction === "resolve") {
      card.detail()
        .title('Status')
        .text('Resolved')
      card.action()
        .title("Reopen")
        .target({key: "refapp-action-callService-updateMessage"})
        .parameters({incidentAction: "reopen"})
    }
    if(parameters.incidentAction === "reopen") {
      card.detail()
        .title('Status')
        .text('Reopened')
      card.action()
        .title("Ack")
        .target({key: "refapp-action-callService-updateMessage"})
        .parameters({incidentAction: "ack"})
      card.action()
        .title("Resolve")
        .target({key: "refapp-action-callService-updateMessage"})
        .parameters({incidentAction: "resolve"})
    }
    card.context("A footer")
      .icon({url: "https://image.ibb.co/fPPAB5/Stride_White_On_Blue.png", label: "Stride"});

    const document = doc.toJSON();

    stride.updateMessage({cloudId, conversationId, messageId: messageId, document: document})
      .then(() => res.send(JSON.stringify({})));
  }
);





async function showCaseHighLevelFeatures({reqBody}) {
  const cloudId = reqBody.cloudId;
  const conversationId = reqBody.conversation.id;
  const senderId = reqBody.sender.id;
  const messageId = reqBody.message.id;
  let user;

  await convertMessageToPlainTextAndReportIt()
  /*
  await extractAndSendMentions()
  await getAndReportUserDetails()
  await sendMessageWithFormatting()
  await sendMessageWithImage()
  await sendMessageWithAction()
  await sendMessageThatUpdates()
  await updateGlance()
  */

  async function convertMessageToPlainTextAndReportIt() {
    console.log('  - convertMessageToPlainTextAndReportIt...');

    await stride.replyWithText({reqBody, text: "Converting the message you just sent to plain text..."});

    // The message is in req.body.message. It is sent using the Atlassian document format.
    // A plain text representation is available in req.body.message.text
    const messageText = reqBody.message.text;
    console.log("    Message in plain text: " + messageText);

    // You can also use a REST endpoint to convert any Atlassian document to a plain text representation:
    const msgInText = await stride.convertDocToText(reqBody.message.body);
    console.log("    Message converted to text: " + msgInText);

    const doc = new Document();
    doc.paragraph()
      .text("In plain text, it looks like this: ")
      .text(`"${msgInText}"`);
    const document = doc.toJSON();

    const response = await stride.reply({reqBody, document});
    console.log('response=', response)
    console.log('MESSAGE ID IS', response.id)

    return messageText;
  }

  async function extractAndSendMentions() {
    console.log('  - extractAndSendMentions...');
    const doc = new Document();

    const paragraph = doc.paragraph()
      .text('The following people were mentioned: ');
    // Here's how to extract the list of users who were mentioned in this message
    const mentionNodes = jsonpath.query(reqBody, '$..[?(@.type == "mention")]');

    // and how to mention users
    mentionNodes.forEach(function (mentionNode) {
        const userId = mentionNode.attrs.id;
        const userMentionText = mentionNode.attrs.text;
        // If you don't know the user's mention text, call the User API - stride.getUser()
        paragraph.mention(userId, userMentionText);
      }
    );

    const document = doc.toJSON();
    await stride.reply({reqBody, document});
  }

  async function getAndReportUserDetails() {
    await stride.replyWithText({reqBody, text: "Getting user details for the sender of the message..."});
    user = await stride.getUser({cloudId, userId: senderId});
    await stride.replyWithText({reqBody, text: "This message was sent by: " + user.displayName});

    return user;
  }

  async function sendMessageWithFormatting() {
    await stride.replyWithText({reqBody, text: "Sending a message with plenty of formatting..."});

    // Here's how to send a reply with a nicely formatted document, using the document builder library adf-builder
    const doc = new Document();
    doc.paragraph()
      .text('Here is some ')
      .strong('bold test')
      .text(' and ')
      .em('text in italics')
      .text(' as well as ')
      .link(' a link', 'https://www.atlassian.com')
      .text(' , emojis ')
      .emoji(':smile:')
      .emoji(':rofl:')
      .emoji(':nerd:')
      .text(' and some code: ')
      .code('const i = 0;')
      .text(' and a bullet list');
    doc.bulletList()
      .textItem('With one bullet point')
      .textItem('And another');
    doc.panel("info")
      .paragraph()
      .text("and an info panel with some text, with some more code below");
    doc.codeBlock("javascript")
      .text('const i = 0;\nwhile(true) {\n  i++;\n}');

    doc
      .paragraph()
      .text("And a card");
    const card = doc.applicationCard('With a title')
      .link('https://www.atlassian.com')
      .description('With some description, and a couple of attributes');
    card.detail()
      .title('Type')
      .text('Task')
      .icon({
        url: 'https://ecosystem.atlassian.net/secure/viewavatar?size=xsmall&avatarId=15318&avatarType=issuetype',
        label: 'Task'
      });
    card.detail()
      .title('User')
      .text('Joe Blog')
      .icon({
        url: 'https://ecosystem.atlassian.net/secure/viewavatar?size=xsmall&avatarId=15318&avatarType=issuetype',
        label: 'Task'
      });

    const document = doc.toJSON();

    await stride.reply({reqBody, document});
  }

  async function sendMessageWithAction() {

    await stride.replyWithText({reqBody, text: "Sending messages with actions..."});

    // First, a card with buttons

    const doc = new Document();

    const card = doc.applicationCard('Another card')
      .link('https://www.atlassian.com')
      .description('With some description, and a couple of actions');
    card.action()
      .title("Open Dialog")
      .target({key: "refapp-action-openDialog"});
    card.action()
      .title("Call Service")
      .target({key: "refapp-action-callService"})
      .parameters({returnError: false, then: "done"});
    card.action()
      .title("Call Service then open sidebar")
      .target({key: "refapp-action-callService"})
      .parameters({then: "open sidebar"})
    card.action()
      .title("Open Sidebar")
      .target({key: "refapp-action-openSidebar"});
    card.action()
      .title("Show error")
      .target({key: "refapp-action-callService"})
      .parameters({returnError: true, then: "done"});
    card.context("A footer")
      .icon({url: "https://image.ibb.co/fPPAB5/Stride_White_On_Blue.png", label: "Stride"});

    const document = doc.toJSON();

    await stride.reply({reqBody, document});

    //Then, a message with a link that opens a dialog when you click on it

    const document2 = {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            {
              "type": "text",
              "text": "Click me to open a Dialog",
              "marks": [
                {
                  "type": "action",
                  "attrs": {
                    "title": "open dialog",
                    "target": {
                      "key": "refapp-action-openDialog"
                    },
                    "parameters": {
                      "expenseId": 123
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    };

    await stride.reply({reqBody, document: document2});
  }

  async function sendMessageThatUpdates() {

    await stride.replyWithText({reqBody, text: "Sending messages with actions..."});

    // Send a message which contains a card with actions. When a user clicks on the action, the message gets replaced
    // by another one with other actions.

    const doc = new Document();

    const card = doc.applicationCard('Incident #4253')
      .link('https://www.atlassian.com')
      .description('Something is broken')
    card.action()
      .title("Ack")
      .target({key: "refapp-action-callService-updateMessage"})
      .parameters({incidentAction: "ack"})
    card.action()
      .title("Resolve")
      .target({key: "refapp-action-callService-updateMessage"})
      .parameters({incidentAction: "resolve"})
    card.context("A footer")
      .icon({url: "https://image.ibb.co/fPPAB5/Stride_White_On_Blue.png", label: "Stride"});

    const document = doc.toJSON();

    await stride.reply({reqBody, document});

  }


  async function sendMessageWithImage() {
    await stride.replyWithText({reqBody, text: "Uploading an image..."});

    // To send a file or an image in a message, you first need to upload it
    const https = require('https');
    const imgUrl = 'https://media.giphy.com/media/L12g7V0J62bf2/giphy.gif';

    return new Promise((resolve, reject) => {
      https.get(imgUrl, function (downloadStream) {
        stride.sendMedia({
            cloudId,
            conversationId,
            name: "an_image2.jpg",
            stream: downloadStream,
          })
          .then(JSON.parse)
          .then(response => {
            if (!response || !response.data)
              throw new Error('Failed to upload media!')

            // Once uploaded, you can include it in a message
            const mediaId = response.data.id;
            const doc = new Document();
            doc.paragraph()
              .text("and here's that image:");
            doc
              .mediaGroup()
              .media({type: 'file', id: mediaId, collection: conversationId});

            return stride.reply({reqBody, document: doc.toJSON()})
          })
          .then(resolve, reject);
      });
    });
  }

  async function updateGlance() {
    await stride.replyWithText({reqBody, text: "Updating the glance state..."});

    // Here's how to update the glance state
    const stateTxt = `Click me, ${user.displayName} !!`;
    await stride.updateGlanceState({
      cloudId,
      conversationId,
      glanceKey: "refapp-glance",
      stateTxt,
    });
    console.log("glance state updated to: " + stateTxt);
    await stride.replyWithText({reqBody, text: `It should be updated to "${stateTxt}" -->`});
  }
}

async function demoLowLevelFunctions({reqBody}) {
  const cloudId = reqBody.cloudId;
  const conversationId = reqBody.conversation.id;

  let user;
  let createdConversation;

  await stride.replyWithText({reqBody, text: `That was nice, wasn't it?`});
  await stride.replyWithText({
    reqBody,
    text: `Now let me walk you through the lower level functions available in the tutorial "refapp":`
  });

  await demo_sendTextMessage();
  await demo_sendMessage();
  await demo_replyWithText();
  await demo_reply();
  await demo_getUser();
  await demo_sendPrivateMessage();
  await demo_getConversation();
  await demo_createConversation();
  await demo_archiveConversation();
  await demo_getConversationHistory();
  await demo_getConversationRoster();
  await demo_createDocMentioningUser();
  await demo_convertDocToText();
  await demo_convertMarkdownToDoc();

  async function demo_sendTextMessage() {
    console.log(`------------ sendTextMessage() ------------`);

    await stride.sendTextMessage({cloudId, conversationId, text: `demo - sendTextMessage() - Hello, world!`});
  }

  async function demo_sendMessage() {
    console.log(`------------ sendMessage() ------------`);

    // using the Atlassian Document Format
    // https://developer.atlassian.com/cloud/stride/apis/document/structure/
    const exampleDocument = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `demo - sendMessage() - Hello, world!`,
            },
          ]
        }
      ]
    };
    await stride.sendMessage({cloudId, conversationId, document: exampleDocument});
  }

  async function demo_replyWithText() {
    console.log(`------------ replyWithText() ------------`);

    await stride.replyWithText({reqBody, text: `demo - replyWithText() - Hello, world!`});
  }

  async function demo_reply() {
    console.log(`------------ reply() ------------`);

    await stride.reply({reqBody, document: stride.convertTextToDoc(`demo - reply() - Hello, world!`)});
  }

  async function demo_getUser() {
    console.log(`------------ getUser() ------------`);

    user = await stride.getUser({
      cloudId,
      userId: reqBody.sender.id,
    });
    console.log('getUser():', prettify_json(user));
    await stride.replyWithText({reqBody, text: `demo - getUser() - your name is "${user.displayName}"`});
    return user;
  }

  async function demo_sendPrivateMessage() {
    console.log(`------------ sendPrivateMessage() ------------`);

    await stride.replyWithText({reqBody, text: "demo - sendPrivateMessage() - sending you a private message…"});

    try {
      const document = await stride.createDocMentioningUser({
        cloudId,
        userId: user.id,
        text: 'Hello {{MENTION}}, thanks for taking the Stride tutorial!',
      });

      await stride.sendPrivateMessage({
        cloudId,
        userId: user.id,
        document,
      });
    }
    catch (e) {
      await stride.replyWithText({
        reqBody,
        text: "Didn't work, but maybe you closed our private conversation? Try re-opening it... (please ;)"
      });
    }
  }

  async function demo_getConversation() {
    console.log(`------------ getConversation() ------------`);

    const conversation = await stride.getConversation({cloudId, conversationId});
    console.log('getConversation():', prettify_json(conversation));

    await stride.replyWithText({
      reqBody,
      text: `demo - getConversation() - current conversation name is "${conversation.name}"`
    });
  }

  async function demo_createConversation() {
    console.log(`------------ createConversation() ------------`);
    const candidateName = `Stride-tutorial-Conversation-${+new Date()}`;

    const response = await stride.createConversation({cloudId, name: candidateName});
    console.log('createConversation():', prettify_json(response));

    // When your app creates a conversation, it automatically gets installed there.
    // However it's currently happening asynchronously, so there might be some time after the conversation is created
    // before you can access it.
    // The following is a hack to get around it.
    // For a reliable solution, your app should wait for an installation event from the created conversation.
    const timeout = ms => new Promise(res => setTimeout(res, ms))
    await timeout(2000)

    createdConversation = await stride.getConversation({cloudId, conversationId: response.id});
    await stride.sendTextMessage({
      cloudId,
      conversationId: createdConversation.id,
      text: `demo - createConversation() - Hello, conversation!`
    });

    const doc = new Document();
    doc.paragraph()
      .text(`demo - createConversation() - conversation created with name "${createdConversation.name}". Find it `)
      .link('here', createdConversation._links[createdConversation.id]);
    await stride.reply({reqBody, document: doc.toJSON()});
  }

  async function demo_archiveConversation() {
    console.log(`------------ archiveConversation() ------------`);

    const response = await stride.archiveConversation({cloudId, conversationId: createdConversation.id});
    console.log('archiveConversation():', prettify_json(response));

    await stride.replyWithText({
      reqBody,
      text: `demo - archiveConversation() - archived conversation "${createdConversation.name}"`
    });
  }

  async function demo_getConversationHistory() {
    console.log(`------------ getConversationHistory() ------------`);

    const response = await stride.getConversationHistory({cloudId, conversationId});
    console.log('getConversationHistory():', prettify_json(response));

    await stride.replyWithText({
      reqBody,
      text: `demo - getConversationHistory() - seen ${response.messages.length} recent message(s)`
    });
  }

  async function demo_getConversationRoster() {
    console.log(`------------ getConversationRoster() ------------`);

    const response = await stride.getConversationRoster({cloudId, conversationId});
    console.log('getConversationRoster():', prettify_json(response));

    const userIds = response.values;
    const users = await Promise.all(userIds.map(userId => stride.getUser({cloudId, userId})))
    console.log('getConversationRoster() - users():', prettify_json(users));

    await stride.replyWithText({
      reqBody,
      text: `demo - getConversationRoster() - seen ${users.length} users: `
      + users.map(user => user.displayName).join(', '),
    });
  }

  async function demo_createDocMentioningUser() {
    console.log(`------------ createDocMentioningUser() ------------`);

    const document = await stride.createDocMentioningUser({
      cloudId,
      userId: user.id,
      text: "demo - createDocMentioningUser() - See {{MENTION}}, I can do it!"
    });

    await stride.reply({reqBody, document});
  }

  async function demo_convertDocToText() {
    console.log(`------------ convertDocToText() ------------`);

    const doc = new Document();
    doc.paragraph()
      .text(`demo - convertDocToText() - this an ADF document with a link: `)
      .link('https://www.atlassian.com/', 'https://www.atlassian.com/');

    const document = doc.toJSON();
    await stride.reply({reqBody, document});

    const text = await stride.convertDocToText(document);

    await stride.replyWithText({reqBody, text: text + ' <-- converted to text!'});
  }

  async function demo_convertMarkdownToDoc() {
    console.log(`------------ convertMarkdownToDoc() ------------`);

    const markdown =  "Here's some **markdown**: Hello *world*, we hope you're enjoying [Stride](https://www.stride.com)";

    const document = await stride.convertMarkdownToDoc(markdown);

    await stride.replyWithText({
      reqBody,
      text: `demo - convertMarkdownToDoc()`
    });
    await stride.reply({reqBody, document});

  }
}




http.createServer(app).listen(PORT, function () {
  console.log('App running on port ' + PORT);
});
