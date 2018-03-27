const { Persisted, Persistable, Cached } = require('..')
const { removeSync } = require('fs-extra')
suite('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Persistable.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	class City extends Persisted {

	}
	class Country extends Persisted {

	}
	class CityWithCountry extends City.cacheWith({
		countryId: '',
		country: Country.relatedBy('countryId'), // Country.relatedByAll('countryIds') for multiple values
	}) {}
	const CountryWithCities = Country.cacheWith({
		cities: City.relatesBy('countryId')
	})
	suiteSetup(() => {
		return Promise.all([
			CityWithCountry.register({ version: 1 }),
			CountryWithCities.register({ version: 1})
		])
	})

	test('many-to-one', async () => {
		Country.set('usa', {name: 'USA'})
		Country.set('france', {name: 'France'})
		City.set('la', {name: 'LA', countryId: 'usa'})
		City.set('slc', {name: 'SLC', countryId: 'usa'})
		City.set('paris', {name: 'Parise', countryId: 'france'})
		await CityWithCountry.whenUpdatedFrom(City)
		await CityWithCountry.whenUpdatedFrom(Country)
		let la = await CityWithCountry.for('la')
		assert.equal(la.name, 'LA')
		assert.equal(la.country.name, 'USA')
	})
	test('one-to-many', async () => {
		await CountryWithCities.whenUpdatedFrom(City)
		await CountryWithCities.whenUpdatedFrom(Country)
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
