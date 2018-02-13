const request = require('request')
const jwtUtil = require('jwt-simple')
const fs = require('fs')

const prettyjson = require('prettyjson')
function prettify_json(data, options = {}) {
  return '{\n' + prettyjson.render(data, options) + '\n}'
}

const debugId = 'chess-api.js'
const logger = console

const {GAME_AI_URL, GAME_API_URL, GAME_API_KEY} = process.env;
if (!GAME_AI_URL) throw `Missing required env variable: GAME_AI_URL`
if (!GAME_API_URL) throw `Missing required env variable: GAME_API_URL`
if (!GAME_API_KEY) throw `Missing required env variable: GAME_API_KEY`

const GAME_API_RULES = 'chess'

function r2(options) {
  let logDetails = {
    request: options
  }

  return new Promise((resolve, reject) => {
    logger.info(`- ${debugId}: requesting...` + options.method + '/' + options.uri)

    request(options, (err, response, body) => {
      if (err) {
        logger.error(`! ${debugId}: request failed! details =`, prettify_json({logDetails, err}))
        return reject(err)
      }

      if (!response || response.statusCode >= 399) {
        logger.error(`! ${debugId}: request failed with an error response! details =`, prettify_json({logDetails, responseBody: response.body, err}))
        let error = JSON.parse(body)
        if (error) error = error.error
        return reject(new Error(error || 'Unexpected Game API error'))
      }

      const json = JSON.parse(body)

      console.log('response', prettify_json(json))
      resolve(json)
    })
  })
}

function gameApiCall(method, url) {
  const options = {
    uri: `${GAME_API_URL}${url}`,
    method,
    headers: {
      'X-GameApiKey': GAME_API_KEY
    }
  }
  return r2(options)
}

function chessAiApiCall(method, url) {
  const options = {
    uri: `${GAME_AI_URL}${url}`,
    method
  }
  return r2(options)
}

class ChessApi {
  createGame(playerContacts) {
    return new Promise((resolve, reject) => {
      
      // maybe we should combine this all into a single POST request to /games
      // using something like: ?player=...&player=...

      gameApiCall('POST', `/games?rules=${GAME_API_RULES}`).then(data => {
        const game = data.game
        const gameId = game.game_id

        game.current_game_state = game.game_states[0]

        Promise.all(playerContacts.map((playerContact, playerNumber) =>
          gameApiCall('PUT', `/games/${gameId}/players/${playerNumber}?contact=${encodeURIComponent(playerContact)}`)
        )).then(data => {
          
          data.forEach((datum, playerNumber) => {
            game.game_players[playerNumber] = datum.game_player
          })

          resolve(game)
        }).catch(error => {
          reject(error)
        })

      }).catch(error => {
        reject(error)
      })
    })
  }

  performMove(game, move, moveFormat='san') {
    const gameId = game.game_id
    const nextVersion = game.current_game_state.version + 1
    
    return new Promise((resolve, reject) => {
      gameApiCall('PUT', `/games/${gameId}/states/${nextVersion}?move=${encodeURIComponent(move)}&format=${moveFormat}`).then(data => {
        const gameState = data.game_state
        
        game.game_states.push(gameState)
        game.current_game_state = gameState

        resolve(gameState)
      }).catch(error => {
        reject(error)
      })
    })
  }

  performAIMove(game) {
    const depth = 7
    const fen = game.current_game_state.state.fen

    return new Promise((resolve, reject) => {
      chessAiApiCall('GET', `/moves?fen=${encodeURIComponent(fen)}&depth=${depth}`).then(data => {
        // {"bestmove":"g7g6","actualdepth":10,"interrupted":false,"millis":1271,"ponder":"d7d8"}

        if (!data.bestmove) {
          reject('Chess AI API failed')
          return
        }

        this.performMove(game, data.bestmove, 'bestmove').then(gameState => {
          resolve(gameState)
        }).catch(error => {
          reject(error)
        })
      }).catch(error => {
        reject(error)
      })
    })
  }
}

module.exports = new ChessApi()
