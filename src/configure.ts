import { configure as configurePersisted } from './Persisted.js'
import { setRequestContextClass } from './RequestContext.js'
export function configure(options) {
	if (options.dbFolder || options.cacheDbFolder || options.doesInitialization !== undefined) {
		configurePersisted(options)
	}
	if (options.RequestContext) {
		setRequestContextClass(options.RequestContext)
	}
}
