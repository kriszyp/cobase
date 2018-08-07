let resourceEditor
const fs = require('fs')
import { createSerializeStream } from 'dpack'
export const htmlMediaType = {
	q: 0.2,
	serialize(data, connection, parameters) {
		// TODO: Cache this
		connection.response.headers['transfer-encoding'] = 'chunked'
		var stream = createSerializeStream()
		stream.push(fs.readFileSync(require.resolve('../../client/resource-viewer.html')))
		const push = stream.push
		stream.push = function(chunk) {
			if (chunk) {
				push.call(stream, '<script>nextData(' + JSON.stringify(chunk.toString()) + ')</script>') // .replace(/(["/\n\r\\])/g, '\\$1'
			} else {
				push.call(stream, '<script>finished()</script></html>')
				push.call(stream, null)
			}
		}
		stream.write(data)
		stream.end()
		return stream
	}
}
export function sendResourceEditor(connection) {
	connection.body = connection.response.content = fs.readFileSync(require.resolve('alkali/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('dpack/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('../../client/resource-viewer.js'))
}
