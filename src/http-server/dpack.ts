import { createSerializeStream, decode } from 'dpack'
import { Readable } from 'stream'

export const dpackMediaType = {
	parse: (content) => content.length > 0 ? decode(content) : undefined, // tolerate empty requests
	serialize(data, connection, parameters) {
		connection.response.headers['Transfer-Encoding'] = 'chunked'
		var stream = createSerializeStream()
		stream.write(data)
		stream.end()
		return stream
	}
}
