# webgl-map
**_Note: this repo is for learning purposes only, and not intended for production use_**

### [See Demo](https://ckochis.com/webgl-map-demo)

This repo contains the code that accompanies the [Build a WebGL Vector Map](https://ckochis.com/build-a-webgl-vector-map-from-scratch) tutorial.

It's pirmarily used as an exercise in learning WebGL and rendering Vector Tiles. Any comments or suggestions are more than welcome 😄

## Usage

To use, a map can be instantiated with the `id` of the div to render to. 

```js
const map = new WebGLMap({
  id: 'myCanvasId',
  tileServerURL: 'https://maps.ckochis.com/data/v3/{z}/{x}/{y}.pbf',
  width: 800,
  height: 600,
  center: [-73.9834558, 40.6932723]
  minZoom: 4,
  maxZoom: 18,
  zoom: 13,
  debug: true,
  layers: {
    water: [180, 240, 250, 255],
    landcover: [202, 246, 193, 255],
    park: [202, 255, 193, 255],
    building: [185, 175, 139, 191],
  }
});
```

The other requrement is a URL to a tile server that uses the [Mapbox Vector Tile Specification](https://github.com/mapbox/vector-tile-spec).
```js
// example
"https://maps.ckochis.com/data/v3/{z}/{x}/{y}.pbf"
```

You will also need to specify the layers to render, along with an RBG value. The demo is using the [OpenMapTiles](https://openmaptiles.org/schema/) scehma.
