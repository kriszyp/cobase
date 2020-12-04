import { PersistedBase, Cached } from './Persisted'
import when from './util/when'
const INITIALIZING_LAST_KEY = Buffer.from([1, 7])

export class Aggregator extends PersistedBase {
	static updateAggregate(previousEntry, entry) {
	}
	static forValue(id, entry) {
		return this.tryForQueueEntry(id, () => {
			this.updateAggregate(entry.previousValue, entry.value)
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
	static get(id, mode?) {
		let entry = this.db.getEntry(id, mode ? 2: 0)
		// don't use versions
		return entry && entry.value
	}

	static fetchAllIds() {
		return []
	}
	static from(...Sources) {
		return Cached.from.apply(this, Sources)
	}
	static openDatabase() {
		this.Sources[0].openChildDB(this, { cache: true })
		return false // is not root
	}
	static getIdsFromKey(key) {
		return this.Sources[0].getIdsFromKey(key)
	}
	static updateDBVersion() {
		if (!this.Sources[0].wasReset) // only reindex if the source didn't do it for us
			this.db.putSync(INITIALIZING_LAST_KEY, this.resumeFromKey = true)
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
