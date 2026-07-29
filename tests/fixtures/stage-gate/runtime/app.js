import http from 'node:http'

const server = http.createServer((_request, response) => {
  response.end('ok')
})

server.listen(18992, () => {
  console.log('ready')
})
