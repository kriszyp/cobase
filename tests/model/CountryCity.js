const { Persisted, Cached } = require('../..')
class City extends Persisted {

}
class Country extends Persisted {

}
class CityWithCountry extends City.cacheWith({
	countryId: '',
	country: Country.relatedBy('countryId'), // Country.relatedByAll('countryIds') for multiple values
}) {}
CityWithCountry.version = 1
const CountryWithCities = Country.cacheWith({
	cities: City.relatesBy('countryId')
})
CountryWithCities.version = 1

City.start()
exports.City = City
Country.start()
exports.Country = Country
CityWithCountry.start()
exports.CityWithCountry = CityWithCountry
CountryWithCities.start()
exports.CountryWithCities = CountryWithCities
