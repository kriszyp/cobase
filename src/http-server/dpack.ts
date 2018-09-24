import { createSerializeStream, parse } from 'dpack'
import { Readable } from 'stream'

export const dpackMediaType = {
	parse: (content, connection) => {
		try {
			return content.length > 0 ? parse(content) : undefined // tolerate empty requests
		} catch(error) {
			console.error('Parse error', error.toString(), 'content-length', connection.request.headers['content-length'], 'content.length', content.length, 'content', content)
			throw error
		}
	},
	serialize(data, connection, parameters) {
		connection.response.headers['Transfer-Encoding'] = 'chunked'
		var stream = createSerializeStream()
		stream.end(data)
		return stream
	}
}
