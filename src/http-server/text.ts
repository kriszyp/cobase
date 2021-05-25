import { Readable } from 'stream'

export const textMediaType = {
	parse: (content) => content, // just the text
	q: 0.1,
	serialize: (content) => {
		if (content?.next)
			return Readable.from(content)
		return content
	}, // just the text
}
