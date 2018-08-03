import when from '../util/when'
import { bufferStream } from '../util/bufferStream'
import { jsonMediaType } from './JSONStream'
import { dpackMediaType } from './dpack'
import { textMediaType } from './text'
import { htmlMediaType, sendResourceEditor } from './html'

export const mediaTypes = new Map()
export function media(connection, next) {
	let request = connection.request
	if (connection.path.indexOf('cobase-resource-viewer') > -1) {
		return sendResourceEditor(connection)
	}
	let headers = request.headers
	const options = {
		charset: 'utf8'
	}
	const contentType = headers['content-type']
	if (contentType) {
		let [mimeType, optionsString] = contentType.split(/\s*;\s*/)
		if (optionsString) {
			optionsString.replace(/([^=]+)=([^;]+)/g, (t, name, value) =>
				options[name] = value)
		}
		let parser = mediaTypes.get(mimeType)
		if (!parser || !parser.parse) {
			if (headers['content-length'] == '0') {
				parser = EMPTY_MEDIA_PARSER
			} else {
				connection.status = 415
				connection.response.content = 'Unsupported media type ' + mimeType
				return
			}
		}
		if (parser.handlesRequest) {
			return when(parser.handle(connection), () =>
				when(connection.call(app), (returnValue) => serializer(returnValue, connection)))
		}
		return bufferStream(connection.req).then(data => {
			connection.request.data = parser.parse(data.toString(options.charset))
			return when(next(), (returnValue) => serializer(returnValue, connection))
		})
	}
	return when(next(), (returnValue) => serializer(returnValue, connection))
}
function serializer(returnValue, connection) {
	returnValue = connection.data !== undefined ? connection.data :
		connection.response.data !== undefined ? connection.response.data : returnValue
	if (returnValue === undefined)
		return // nothing to serialize
	let requestHeaders = connection.request.headers
	let acceptHeader = requestHeaders.accept || '*/*'
	let responseHeaders = connection.response.headers
	responseHeaders.vary = (responseHeaders.vary ? responseHeaders.vary + ',' : '') + 'Accept'
	let bestSerializer = jsonMediaType // default for now, TODO: return a 415
	let bestQuality = 0
	let bestType = 'application/json' // default
	let bestParameters
	const acceptTypes = acceptHeader.split(/\s*,\s*/);
	for (const acceptType of acceptTypes) {
		const [type, ...parameterParts] = acceptType.split(/\s*;\s*/)
		let clientQuality = 1
		const parameters = { q: 1 }
		for(const part of parameterParts) {
			const equalIndex = part.indexOf('=')
			parameters[part.substring(0, equalIndex)] = part.substring(equalIndex + 1)
		}
		clientQuality = +parameters.q
		const serializer = mediaTypes.get(type)
		if (serializer) {
			const quality = (serializer.q || 1) * clientQuality
			if (quality > bestQuality) {
				bestSerializer = serializer
				bestType = type
				bestQuality = quality
				bestParameters = parameters
			}
		}
	}
	if (connection.response.set) {
		connection.response.set('content-type', bestType)
		connection.response.set('vary', 'Accept')
	} else {
		responseHeaders['content-type'] = bestType
	}
	connection.response.body = connection.response.content = bestSerializer.serialize(returnValue, connection, bestParameters)
}

mediaTypes.set('text/dpack', dpackMediaType)
mediaTypes.set('application/json', jsonMediaType)
mediaTypes.set('text/plain', textMediaType)
mediaTypes.set('text/html', htmlMediaType)
const EMPTY_MEDIA_PARSER = {
	parse() {
	}
}

