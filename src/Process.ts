export default Process = (Class, { processName }) => {
	const inProcess = process.name == processName
	if (inProcess) {
		return Class
	}
	let childProcess = spawn()
	childProcess.onmessage = () => {

	}
	class ProcessProxy extends Transform {
		// TODO: use the expiration strategy
		transform() {
			return this.sendRequestToChild()
		}
		put() {
			this.sendRequestToChild()
		}
		sendRequestToChild() {

		}
	}
}

