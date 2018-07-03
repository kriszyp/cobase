import { encode } from 'dpack/lib/encode'
import { decode } from 'dpack/lib/decode'
import { Readable } from 'stream'

export const dpackMediaType = {
	parse: (content) => content.length > 0 ? decode(content) : undefined, // tolerate empty requests
	serialize(data, connection, parameters) {
		connection.response.headers['Transfer-Encoding'] = 'chunked'
		return encode(data)
		var stream = new createEncodeStream({
			asDocument: Boolean(/dpack/.test(parameters.ext))
		})
		stream.write(data)
		stream.end()
		return stream
	}
}
