let resourceEditor
const fs = require('fs')
export const htmlMediaType = {
	q: 0.2,
	serialize(data, connection, parameters) {
		// TODO: Cache this
		return fs.readFileSync(require.resolve('../../client/resource-viewer.html'))
	}
}
export function sendResourceEditor(connection) {
	connection.body = connection.response.content = fs.readFileSync(require.resolve('alkali/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('dpack/dist/index')) + '\n' +
		fs.readFileSync(require.resolve('../../client/resource-viewer.js'))
}
