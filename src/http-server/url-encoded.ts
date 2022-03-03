import { encode, decode } from 'querystring'
export const urlEncodedMediaType = {
	q: 0.8,
	parse: (content) => content.length > 0 ? decode(content) : undefined, // tolerate empty requests
	serialize(data, connection) {
		encode(data)
	}
}
