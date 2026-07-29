import http from 'node:http'

const request = http.get('http://localhost:18992', (response) => {
  let body = ''
  response.on('data', (chunk) => {
    body += chunk
  })
  response.on('end', () => {
    console.log('response:', body)
    process.exitCode = body === 'ok' ? 0 : 1
  })
})

request.on('error', () => {
  process.exitCode = 1
})
