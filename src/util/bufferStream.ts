export let maxRequestBody = 10000000 // default to 10MB
export function bufferStream(stream) {
	return new Promise((resolve, reject) => {
		var chunks = []
		var length = 0
		stream.on('data', (data) => {
			chunks.push(data)
			length += data.length
			if (length > maxRequestBody) {
				stream.connection.destroy()
				const error = new Error('Request Entity Too Large')
				error.status = 413
				reject(error)
			}
		})
		stream.on('end', () => {
			resolve(Buffer.concat(chunks, length))
		})
	})
}
