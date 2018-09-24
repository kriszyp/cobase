/*dpack.fetch(location.href).then(function(response) {
	return response.text()
}).then(function(text) {
	window.text = text
	//console.log(window.data = data)
	for (var i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) !== data.charCodeAt(i)) {
			console.log('Differ at',i, text.charCodeAt(i), data.charCodeAt(i))
			break
		}
	}
	document.getElementById('details').append(renderExpandedObject(dpack.parse(text)))
})*/
var source = ''
window.nextData = function(nextChunk) {
	source += nextChunk
}
window.finished = function() {
	document.getElementById('details').append(renderExpandedObject(window.data = dpack.parse(source)))
}
HTMLElement.prototype.append = alkali.append

var Table = alkali.Table
var TR = alkali.TR
var TD = alkali.TD
var THead = alkali.THead
var TH = alkali.TH
var Span = alkali.Span
var Div = alkali.Div
function renderExpandedObject(object) {
	var rows = []
	for (var key in object) {
		let value = object[key]
		rows.push(TR([
			TD('.expando-cell', [
				(value && typeof value === 'object') ? Div('.expando') : null
			]),
			TD('.property', [
				Span([key, ': ']),
				Span('.value-summary', [renderValue(value)])
			])
		], {
			onclick: function(event) {
				event.stopPropagation()
				if (!this.hasExpanded) {
					this.hasExpanded = true
					this.append(TD('.property-expanded', {
					}, [ value.constructor === Array ?
						renderExpandedArray(value) : renderExpandedObject(value) ]))
				}
				if (this.expanded) {
					this.className = this.className.replace(/expanded/g, '') + ' collapsed'
					this.expanded = false
				} else {
					this.className = this.className.replace(/collapsed/g, '') + ' expanded'
					this.expanded = true
				}
			}
		}))
	}
	return Table(rows)
}
function renderExpandedArray(array) {
	var rows = []
	var columns = []
	var first = array[0]
	if (!first || typeof first != 'object') {
		return renderExpandedObject(array)
	}
	for (var key in first) {
		columns.push(key)
	}
	rows.push(THead([
		TR([TH()].concat(columns.map(column => TH([column]))))
	]))

	for (var index in array) {
		let item = array[index]
		var cells = [
			TD('.expando-cell', [
				(item && typeof item === 'object') ? Div('.expando') : null
		])]
		for (var key in item) {
			cells.push(TD('.property', [
				Span('.value-summary', [renderValue(item[key])])
			]))
		}
		rows.push(TR(cells, {
			onclick: function(event) {
				event.stopPropagation()
				if (!this.hasExpanded) {
					this.hasExpanded = true
					this.append(TD('.property-expanded', {
						colSpan: columns.length
					}, [ renderExpandedObject(item) ]))
				}
				if (this.expanded) {
					this.className = this.className.replace(/expanded/g, '') + ' collapsed'
					this.expanded = false
				} else {
					this.className = this.className.replace(/collapsed/g, '') + ' expanded'
					this.expanded = true
				}
			}
		}))
	}
	return Table(rows)
}

function renderValue(value) {
	if (value && typeof value === 'object') {
		var description
		if (value.constructor == Array) {
			description = 'Array (' + value.length + ')'
			if (value.length === 1) {
				return description + ': ' + renderValue(value[0])
			} else if (value.length > 1) {
				var first = value[0]
				if (first && typeof first === 'object') {
					return description + ' of {' + Object.keys(first).join(', ') + '}'
				} else {
					return description + ': ' + value.join(', ').slice(0, 100)
				}
			}
		} else {
			description = '{'
			for (var key in value) {
				if (description) {
					description += ', '
				}
				description += key + ': ' + renderValue(value[key])
				if (description.length > 100) {
					description = description.slice(0, 100)
					break
				}
			}
			description += '}'
			return description
		}
	} else {
		return JSON.stringify(value)
	}
}
