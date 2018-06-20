const { Persisted, Persistable, Cached } = require('..')
const { removeSync } = require('fs-extra')
const { City, Country, CityWithCountry, CountryWithCities } = require('./model/CountryCity')
suite('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Persistable.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	suiteSetup(() => {
		return Promise.all([
			CityWithCountry.ready,
			CountryWithCities.ready
		])
	})

	test('many-to-one', async () => {
		Country.set('usa', {name: 'USA'})
		Country.set('france', {name: 'France'})
		City.set('la', {name: 'LA', countryId: 'usa'})
		City.set('slc', {name: 'SLC', countryId: 'usa'})
		City.set('paris', {name: 'Parise', countryId: 'france'})
		let la = await CityWithCountry.for('la')
		assert.equal(la.name, 'LA')
		assert.equal(la.country.name, 'USA')
	})
	test('one-to-many', async () => {
		let usa = await CountryWithCities.for('usa')
		assert.equal(usa.name, 'USA')
		assert.equal(usa.cities[0].name, 'LA')
		assert.equal(usa.cities[1].name, 'SLC')
	})

	/*
	suiteTeardown(() => {
		console.log('teardown persisted')
		return Promise.all([
			Test.db.close(),
			TestCached.db.close()
		])
	})*/
})
