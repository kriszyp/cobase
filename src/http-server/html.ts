let resourceEditor
import fs from 'fs'
import { PackrStream } from 'msgpackr'
export const htmlMediaType = {
	q: 0.2,
	serialize(data, connection, parameters) {
		// TODO: Cache this
		connection.response.headers['transfer-encoding'] = 'chunked'
		var stream = new PackrStream()
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
		stream.end(data)
		return stream
	}
}
export function sendResourceEditor(connection) {
	connection.body = connection.response.content = fs.readFileSync(require.resolve('alkali/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('dpack/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('../../client/resource-viewer.js'))
}
