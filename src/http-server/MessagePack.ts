import { EncodeStream, decode } from 'msgpackr'
import { Readable } from 'stream'

export const msgpackMediaType = {
	q: 0.96,
	parse: (content) => content.length > 0 ? decode(content) : undefined, // tolerate empty requests
	serialize(data, connection) {
		connection.response.headers['Transfer-Encoding'] = 'chunked'
		var stream = new EncodeStream()
		stream.write(data)
	}
}
