import { Cached } from './Persisted'
import when from './util/when'
const INITIALIZING_LAST_KEY = Buffer.from([1, 7])

export class Aggregator extends Cached {
	static updateAggregate(previousEntry, entry) {
	}
	static forValue(id, value, indexRequest) {
		indexRequest.value = value
		return this.tryForQueueEntry(id, () => {
			return when(indexRequest && indexRequest.previousEntry, previousEntry => when(this.Sources[0].get(id), value =>
				this.updateAggregate(previousEntry && previousEntry.value, value)))
		})
	}
	static forQueueEntry(id) {
		return this.tryForQueueEntry(id, () => {
			return when(this.Sources[0].get(id), value => this.updateAggregate(null, value))
//				if (complete) {
	//				complete.commit()
		//		}
		})
	}
	static runTransform() {
		return {}
	}
	static fetchAllIds() {
		return [] // start with nothing
	}
	static openDatabase() {
		return this.Sources[0].openChildDB(this, true)
	}
	static getIdsFromKey(key) {
		return this.Sources[0].getIdsFromKey(key)
	}
	static updateDBVersion() {
		if (!this.Sources[0].wasReset) // only reindex if the source didn't do it for us
			this.db.putSync(INITIALIZING_LAST_KEY, this.resumeFromKey = Buffer.from([1, 255]))
		super.updateDBVersion()
	}

	static clearEntries() {
		// don't really have any way of doing this right now
	}
	static resumeQueue() {
		this.state = 'waiting for upstream source to build'
		// explicitly wait for source to finish resuming before our own resuming
		return when(this.Sources[0].resumePromise, () =>
			super.resumeQueue())
	}

	static updated(event, by) {
		// don't do anything, we don't want these events to propagate through here, and we do indexing based on upstream queue
	}
}
