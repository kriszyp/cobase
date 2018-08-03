export let maxRequestBody = 10000000 // default to 10MB
export function bufferStream(stream) {
	return new Promise((resolve, reject) => {
		var content = ''
		stream.on('data', (data) => {
			content += data
			if (content.length > maxRequestBody) {
				stream.connection.destroy()
				const error = new Error('Request Entityt Too Large')
				error.status = 413
				reject(error)
			}
		})
		stream.on('end', () => {
			resolve(content)
		})
	})
}
