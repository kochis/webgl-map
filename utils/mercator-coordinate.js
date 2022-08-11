// helper class for converting lat/lng to "clip" space (x/y only)
// using Web Mercator Projectino (taken from mapbox, slightly modified):
//   https://github.com/mapbox/mapbox-gl-js/blob/main/src/geo/mercator_coordinate.js
class MercatorCoordinate {
  static mercatorXfromLng(lng) {
    return (180 + lng) / 360;
  }

  static mercatorYfromLat(lat) {
    return (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)))) / 360;
  }

  static fromLngLat(lngLat) {
    let x = MercatorCoordinate.mercatorXfromLng(lngLat[0]);
    let y = MercatorCoordinate.mercatorYfromLat(lngLat[1]);

    // adjust so relative to origin at center of viewport, instead of top-left
    x = -1 + (x * 2);
    y = 1 - (y * 2);

    return [x, y];
  }

  static lngFromMercatorX(x) {
    return x * 360 - 180;
  }

  static latFromMercatorY(y) {
    const y2 = 180 - y * 360;
    return 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90;
  }

  static fromXY(xy) {
    let [x, y] = xy;
    const lng = MercatorCoordinate.lngFromMercatorX((1 + x) / 2);
    const lat = MercatorCoordinate.latFromMercatorY((1 - y) / 2);
    return [lng, lat];
  }
}

export default MercatorCoordinate;
