import { Context } from 'alkali'
export class RequestContext extends Context {
	preferJSON: boolean // used by JSONStream to assist with direct JSON transfers
	request: any
	session: any
	constructor(request, session, user?) {
		super(user)
		this.request = request
		this.session = session
	}
	newContext() {
		return new this.constructor(this.request, this.session, this.subject)
	}
	get updatesInProgress(): Map<any, Promise<any>> {
		return this.session.updatesInProgress || (this.session.updatesInProgress = new Map())
	}
}
