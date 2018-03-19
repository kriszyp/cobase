const { Persisted, Cached } = require('..')
const { removeSync } = require('fs-extra')
suite('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	class City extends Persisted {

	}
	class Country extends Persisted {

	}
	class CityWithCountry extends Cached.from(City).with({
		countryId: '',
		country: Country.relatedBy('countryId') // Country.relatedByAll('countryIds') for multiple values
	}) {}
	const CountryWithCities = Cached.from(Country).with({
		cities: City.relatesBy('countryId')
	})
	suiteSetup(() => {
		removeSync('tests/db')
		return Promise.all([
			CityWithCountry.register({ version: 1 }),
			CountryWithCities.register({ version: 1})
		])
	})

	test('many-to-one', () => {
		Country.set('usa', {name: 'USA'})
		Country.set('france', {name: 'France'})
		City.set('la', {name: 'LA', countryId: 'usa'})
		City.set('slc', {name: 'SLC', countryId: 'usa'})
		City.set('paris', {name: 'Parise', countryId: 'france'})
		return CityWithCountry.for('la').then(la => {
			assert.equal(la.name, 'LA')
			assert.equal(la.country.name, 'USA')
		})
	})
	test('one-to-many', () => {
		return CountryWithCities.for('usa').then(usa => {
			assert.equal(usa.name, 'USA')
			assert.equal(usa.cities[0].name, 'LA')
			assert.equal(usa.cities[1].name, 'SLC')
		})
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
