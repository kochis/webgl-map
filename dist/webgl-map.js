var Radar = (function (axios, Protobuf, earcut, tilebelt, vectorTile, glMatrix, Stats) {
  'use strict';

  function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

  var axios__default = /*#__PURE__*/_interopDefaultLegacy(axios);
  var Protobuf__default = /*#__PURE__*/_interopDefaultLegacy(Protobuf);
  var earcut__default = /*#__PURE__*/_interopDefaultLegacy(earcut);
  var tilebelt__default = /*#__PURE__*/_interopDefaultLegacy(tilebelt);
  var Stats__default = /*#__PURE__*/_interopDefaultLegacy(Stats);

  function _defineProperty(obj, key, value) {
    if (key in obj) {
      Object.defineProperty(obj, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      obj[key] = value;
    }

    return obj;
  }

  const createShader = (gl, type, source) => {
    let shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    let success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

    if (success) {
      return shader;
    }

    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
  };
  const createProgram = (gl, vertexShader, fragmentShader) => {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    let success = gl.getProgramParameter(program, gl.LINK_STATUS);

    if (success) {
      return program;
    }

    console.error(gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
  };
  const getPrimitiveType = (gl, type) => {
    switch (type) {
      case 'point':
        return gl.POINTS;

      case 'line':
        return gl.LINES;

      default:
        // polygon
        return gl.TRIANGLES;
    }
  };

  // helper class for converting lat/lng to "clip" space (x/y only)
  // using Web Mercator Projectino (taken from mapbox, slightly modified):
  //   https://github.com/mapbox/mapbox-gl-js/blob/main/src/geo/mercator_coordinate.js
  class MercatorCoordinate {
    static mercatorXfromLng(lng) {
      return (180 + lng) / 360;
    }

    static mercatorYfromLat(lat) {
      return (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;
    }

    static fromLngLat(lngLat) {
      let x = MercatorCoordinate.mercatorXfromLng(lngLat[0]);
      let y = MercatorCoordinate.mercatorYfromLat(lngLat[1]); // adjust so relative to origin at center of viewport, instead of top-left

      x = -1 + x * 2;
      y = 1 - y * 2;
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

  const verticesFromPolygon = coordinates => {
    const data = earcut__default["default"].flatten(coordinates);
    const triangles = earcut__default["default"](data.vertices, data.holes, 2);
    const vertices = new Float32Array(triangles.length * 2);

    for (let i = 0; i < triangles.length; i++) {
      const point = triangles[i];
      const lng = data.vertices[point * 2];
      const lat = data.vertices[point * 2 + 1];
      const [x, y] = MercatorCoordinate.fromLngLat([lng, lat]);
      vertices[i * 2] = x;
      vertices[i * 2 + 1] = y;
    }

    return vertices;
  }; // when constructing a line with gl.LINES, every 2 coords are connected,
  // so we always duplicate the last starting point to draw a continuous line


  const verticesFromLine = coordinates => {
    // seed with initial line segment
    const vertices = [...MercatorCoordinate.fromLngLat(coordinates[0]), ...MercatorCoordinate.fromLngLat(coordinates[1])];

    for (let i = 2; i < coordinates.length; i++) {
      const prevX = vertices[vertices.length - 2];
      const prevY = vertices[vertices.length - 1];
      vertices.push(prevX, prevY); // duplicate prev coord

      vertices.push(...MercatorCoordinate.fromLngLat(coordinates[i]));
    }

    return vertices;
  }; // doing an array.push with too many values can cause
  // stack size errors, so we manually iterate and append


  const append = (arr1, arr2) => {
    arr2.forEach(n => {
      arr1[arr1.length] = n;
    });
  }; // convert a GeoJSON geometry to webgl vertices


  const geometryToVertices = geometry => {
    if (geometry.type === 'Polygon') {
      return verticesFromPolygon(geometry.coordinates);
    }

    if (geometry.type === 'MultiPolygon') {
      const positions = [];
      geometry.coordinates.forEach((polygon, i) => {
        append(positions, verticesFromPolygon([polygon[0]]));
      });
      return positions;
    }

    if (geometry.type === 'LineString') {
      return verticesFromLine(geometry.coordinates);
    }

    if (geometry.type === 'MultiLineString') {
      const positions = [];
      geometry.coordinates.forEach((lineString, i) => {
        append(positions, verticesFromLine(lineString));
      });
      return positions;
    }

    if (geometry.type === 'Point') {
      return MercatorCoordinate.fromLngLat(geometry.coordinates);
    } // unknown or unsupported type


    console.log('Unsupported type:', geometry.type);
    return new Float32Array();
  };

  const formatTileURL = _ref => {
    let {
      tile,
      url
    } = _ref;
    const [x, y, z] = tile.split('/');
    return url.replace('{x}', x).replace('{y}', y).replace('{z}', z);
  };

  const getLayerPrimitive = feature => {
    const type = feature.geometry.type;

    if (type === 'Polygon' || type === 'MultiPolygon') {
      return 'polygon';
    }

    if (type === 'Point') {
      return 'point';
    }

    if (type === 'LineString' || type === 'MultiLineString') {
      return 'line';
    }

    console.log('Unknown feature type', type);
    return 'unknown';
  }; // Fetch tile from server, and convert layer coordinates to vertices


  const fetchTile = async _ref2 => {
    let {
      tile,
      layers,
      url
    } = _ref2;
    const [x, y, z] = tile.split('/').map(Number);
    const tileURL = formatTileURL({
      tile,
      url
    });
    const res = await axios__default["default"].get(tileURL, {
      responseType: 'arraybuffer'
    });
    const pbf = new Protobuf__default["default"](res.data);
    const vectorTile$1 = new vectorTile.VectorTile(pbf);
    const tileData = []; // layers -> featureSets

    for (const layer in layers) {
      var _vectorTile$layers;

      if (vectorTile$1 !== null && vectorTile$1 !== void 0 && (_vectorTile$layers = vectorTile$1.layers) !== null && _vectorTile$layers !== void 0 && _vectorTile$layers[layer]) {
        var _vectorTile$layers$la, _vectorTile$layers$la2;

        const numFeatures = ((_vectorTile$layers$la = vectorTile$1.layers[layer]) === null || _vectorTile$layers$la === void 0 ? void 0 : (_vectorTile$layers$la2 = _vectorTile$layers$la._features) === null || _vectorTile$layers$la2 === void 0 ? void 0 : _vectorTile$layers$la2.length) || 0;
        const polygons = [];
        const points = [];
        const lines = []; // convert feature to vertices

        for (let i = 0; i < numFeatures; i++) {
          const geojson = vectorTile$1.layers[layer].feature(i).toGeoJSON(x, y, z);
          const type = getLayerPrimitive(geojson);

          if (type === 'polygon') {
            polygons.push(...geometryToVertices(geojson.geometry));
          } else if (type === 'point') {
            points.push(...geometryToVertices(geojson.geometry));
          } else if (type === 'line') {
            lines.push(...geometryToVertices(geojson.geometry));
          }
        }

        tileData.push({
          layer,
          type: 'polygon',
          vertices: Float32Array.from(polygons)
        });
        tileData.push({
          layer,
          type: 'point',
          vertices: Float32Array.from(points)
        });
        tileData.push({
          layer,
          type: 'line',
          vertices: Float32Array.from(lines)
        });
      }
    }
    return tileData;
  };

  // shaders
  ////////////

  const vertexShaderSource = "\n  attribute vec2 a_position;\n\n  uniform mat3 u_matrix;\n\n  void main() {\n    gl_PointSize = 3.0;\n\n    vec2 position = (u_matrix * vec3(a_position, 1)).xy;\n    gl_Position = vec4(position, 0, 1);\n  }\n";
  const fragmentShaderSource = "\n  precision mediump float;\n\n  uniform vec4 u_color;\n\n  void main() {\n    gl_FragColor = u_color;\n  }\n"; //////////////
  // constants
  //////////////

  const TILE_SIZE = 512;
  const MAX_TILE_ZOOM = 14;
  const defaultOptions = {
    width: 512,
    height: 512,
    center: [-73.9834558, 40.6932723],
    // BROOKLYN
    minZoom: 0,
    maxZoom: 18,
    zoom: 13,
    tileBuffer: 1,
    disabledLayers: [],
    debug: false
  };

  class WebGLMap {
    constructor() {
      var _this = this;

      let _options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      _defineProperty(this, "setOptions", function () {
        let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
        _this.mapOptions = { ..._this.mapOptions,
          ...options
        };
      });

      _defineProperty(this, "updateMatrix", () => {
        // update camera matrix
        const {
          camera
        } = this;
        const zoomScale = 1 / Math.pow(2, camera.zoom); // inverted

        const widthScale = TILE_SIZE / this.canvas.width;
        const heightScale = TILE_SIZE / this.canvas.height;
        const cameraMat = glMatrix.mat3.create();
        glMatrix.mat3.translate(cameraMat, cameraMat, [camera.x, camera.y]);
        glMatrix.mat3.scale(cameraMat, cameraMat, [zoomScale / widthScale, zoomScale / heightScale]); // update view projection matrix

        const mat = glMatrix.mat3.create();
        const viewMat = glMatrix.mat3.invert([], cameraMat);
        const viewProjectionMat = glMatrix.mat3.multiply([], mat, viewMat);
        this.viewProjectionMat = viewProjectionMat;

        if (this.mapOptions.debug) {
          this.updateDebugInfo();
        }
      });

      _defineProperty(this, "updateTiles", () => {
        // update visible tiles based on viewport
        const bbox = this.getBounds();
        const z = Math.min(Math.trunc(this.camera.zoom), MAX_TILE_ZOOM);
        const minTile = tilebelt__default["default"].pointToTile(bbox[0], bbox[3], z);
        const maxTile = tilebelt__default["default"].pointToTile(bbox[2], bbox[1], z); // tiles visible in viewport

        this.tilesInView = [];
        const [minX, maxX] = [Math.max(minTile[0], 0), maxTile[0]];
        const [minY, maxY] = [Math.max(minTile[1], 0), maxTile[1]];

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            this.tilesInView.push([x, y, z]);
          }
        } // get additional tiles to buffer (based on buffer setting)


        this.bufferedTiles = [];
        const {
          tileBuffer
        } = this.mapOptions;

        for (let bufX = minX - tileBuffer; bufX <= maxX + tileBuffer; bufX++) {
          for (let bufY = minY - tileBuffer; bufY <= maxY + tileBuffer; bufY++) {
            this.bufferedTiles.push([bufX, bufY, z]);
            this.bufferedTiles.push(...tilebelt__default["default"].getChildren([bufX, bufY, z]));
            this.bufferedTiles.push(tilebelt__default["default"].getParent([bufX, bufY, z]));
          }
        } // remove duplicates


        let tilesToLoad = [...new Set([...this.tilesInView.map(t => t.join('/')), ...this.bufferedTiles.map(t => t.join('/'))])]; // make sure tiles are in range

        tilesToLoad = tilesToLoad.filter(tile => {
          const [x, y, z] = tile.split('/').map(Number);
          const N = Math.pow(2, z);
          const validX = x >= 0 && x < N;
          const validY = y >= 0 && y < N;
          const validZ = z >= 0 && z <= MAX_TILE_ZOOM;
          return validX && validY && validZ;
        });
        const inViewLookup = new Set(this.tilesInView.map(t => t.join('/'))); // tile fetching options

        const {
          layers,
          tileServerURL: url
        } = this.mapOptions; // load tiles from tilerServer

        tilesToLoad.forEach(async tile => {
          if (this.tiles[tile]) {
            return; // already loaded, no need to fetch
          } // temp hold for request


          this.tiles[tile] = []; // tile is in main view, processes on the main thread for priority
          // (note: not sure if this actually helps, or works as intneded)

          if (inViewLookup.has(tile)) {
            this.tiles[tile] = await fetchTile({
              tile,
              layers,
              url
            });
            return;
          } // hand off buffered tiles to worker for fetching & processing


          this.tileWorker.postMessage({
            tile,
            layers,
            url
          });
        });
      });

      _defineProperty(this, "handleTileWorker", workerEvent => {
        const {
          tile,
          tileData
        } = workerEvent.data;
        this.tiles[tile] = tileData;
      });

      _defineProperty(this, "handleTileWorkerError", error => {
        console.error('Uncaught worker error.', error);
      });

      _defineProperty(this, "handleMove", moveEvent => {
        const [x, y] = this.getClipSpacePosition(moveEvent); // compute the previous position in world space

        const [preX, preY] = glMatrix.vec3.transformMat3([], [this.startX, this.startY, 0], glMatrix.mat3.invert([], this.viewProjectionMat)); // compute the new position in world space

        const [postX, postY] = glMatrix.vec3.transformMat3([], [x, y, 0], glMatrix.mat3.invert([], this.viewProjectionMat)); // move that amount, because how much the position changes depends on the zoom level

        const deltaX = preX - postX;
        const deltaY = preY - postY;

        if (isNaN(deltaX) || isNaN(deltaY)) {
          return; // abort
        } // only update within world limits


        this.camera.x += deltaX;
        this.camera.y += deltaY; // update view matrix

        this.updateMatrix(); // prevent further pan if at limits

        if (this.atLimits()) {
          this.camera.x -= deltaX; // undo

          this.camera.y -= deltaY; // undo

          this.updateMatrix();
          return; // abort
        } // update tiles


        this.updateTiles(); // save current pos for next movement

        this.startX = x;
        this.startY = y;
      });

      _defineProperty(this, "handlePan", startEvent => {
        startEvent.preventDefault(); // get position of initial drag

        let [startX, startY] = this.getClipSpacePosition(startEvent);
        this.startX = startX;
        this.startY = startY;
        this.canvas.style.cursor = 'grabbing'; // handle move events once started

        window.addEventListener('mousemove', this.handleMove);
        this.hammer.on('pan', this.handleMove); // clear on release

        const clear = event => {
          this.canvas.style.cursor = 'grab';
          window.removeEventListener('mousemove', this.handleMove);
          this.hammer.off('pan', this.handleMove);
          window.removeEventListener('mouseup', clear);
          this.hammer.off('panend', clear);
        };

        window.addEventListener('mouseup', clear);
        this.hammer.on('panend', clear);
      });

      _defineProperty(this, "handleZoom", wheelEvent => {
        wheelEvent.preventDefault();
        const [x, y] = this.getClipSpacePosition(wheelEvent); // get position before zooming

        const [preZoomX, preZoomY] = glMatrix.vec3.transformMat3([], [x, y, 0], glMatrix.mat3.invert([], this.viewProjectionMat)); // update current zoom state

        const prevZoom = this.camera.zoom;
        const zoomDelta = -wheelEvent.deltaY * (1 / 300);
        this.camera.zoom += zoomDelta;
        this.camera.zoom = Math.max(this.mapOptions.minZoom, Math.min(this.camera.zoom, this.mapOptions.maxZoom));
        this.updateMatrix(); // prevent further zoom if at limits

        if (this.atLimits()) {
          this.camera.zoom = prevZoom; // undo

          this.updateMatrix();
          return; // abort
        } // get new position after zooming


        const [postZoomX, postZoomY] = glMatrix.vec3.transformMat3([], [x, y, 0], glMatrix.mat3.invert([], this.viewProjectionMat)); // camera needs to be moved the difference of before and after

        this.camera.x += preZoomX - postZoomX;
        this.camera.y += preZoomY - postZoomY;
        this.updateMatrix();
        this.updateTiles();
      });

      _defineProperty(this, "getClipSpacePosition", e => {
        var _e$center, _e$center2;

        // get position from mouse or touch event
        const [x, y] = [((_e$center = e.center) === null || _e$center === void 0 ? void 0 : _e$center.x) || e.clientX, ((_e$center2 = e.center) === null || _e$center2 === void 0 ? void 0 : _e$center2.y) || e.clientY]; // get canvas relative css position

        const rect = this.canvas.getBoundingClientRect();
        const cssX = x - rect.left;
        const cssY = y - rect.top; // get normalized 0 to 1 position across and down canvas

        const normalizedX = cssX / this.canvas.clientWidth;
        const normalizedY = cssY / this.canvas.clientHeight; // convert to clip space

        const clipX = normalizedX * 2 - 1;
        const clipY = normalizedY * -2 + 1;
        return [clipX, clipY];
      });

      _defineProperty(this, "getBounds", () => {
        const zoomScale = Math.pow(2, this.camera.zoom); // undo clip-space

        const px = (1 + this.camera.x) / this.pixelRatio;
        const py = (1 - this.camera.y) / this.pixelRatio; // get world coord in px

        const wx = px * TILE_SIZE;
        const wy = py * TILE_SIZE; // get zoom px

        const zx = wx * zoomScale;
        const zy = wy * zoomScale; // get bottom-left and top-right pixels

        let x1 = zx - this.canvas.width / 2;
        let y1 = zy + this.canvas.height / 2;
        let x2 = zx + this.canvas.width / 2;
        let y2 = zy - this.canvas.height / 2; // convert to world coords

        x1 = x1 / zoomScale / TILE_SIZE;
        y1 = y1 / zoomScale / TILE_SIZE;
        x2 = x2 / zoomScale / TILE_SIZE;
        y2 = y2 / zoomScale / TILE_SIZE; // get LngLat bounding box

        const bbox = [MercatorCoordinate.lngFromMercatorX(x1), MercatorCoordinate.latFromMercatorY(y1), MercatorCoordinate.lngFromMercatorX(x2), MercatorCoordinate.latFromMercatorY(y2)];
        return bbox;
      });

      _defineProperty(this, "atLimits", () => {
        const bbox = this.getBounds();
        return bbox[0] <= -180 || bbox[1] <= -85.05 || bbox[2] >= 180 || bbox[3] >= 85.05;
      });

      _defineProperty(this, "draw", () => {
        const {
          gl,
          program,
          viewProjectionMat,
          tilesInView,
          tiles,
          mapOptions,
          overlay,
          pixelRatio,
          canvas,
          stats
        } = this; // stats reporting

        let start = performance.now();
        let vertexCount = 0;

        if (mapOptions.debug) {
          stats.begin();
        } // set matrix uniform


        const matrixLocation = gl.getUniformLocation(program, "u_matrix");
        gl.uniformMatrix3fv(matrixLocation, false, viewProjectionMat); // render tiles

        tilesInView.forEach(tile => {
          const featureSets = tiles[tile.join('/')];
          (featureSets || []).forEach(featureSet => {
            const {
              layer,
              type,
              vertices
            } = featureSet;

            if (mapOptions.disabledLayers.includes(layer)) {
              return;
            }

            const color = mapOptions.layers[layer].map(n => n / 255); // RBGA to WebGL
            // set color uniform

            const colorLocation = gl.getUniformLocation(program, "u_color");
            gl.uniform4fv(colorLocation, color); // create buffer for vertices

            const positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW); // setup position attribute

            const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
            gl.enableVertexAttribArray(positionAttributeLocation); // tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)

            const size = 2;
            const dataType = gl.FLOAT;
            const normalize = false;
            const stride = 0;
            let offset = 0;
            gl.vertexAttribPointer(positionAttributeLocation, size, dataType, normalize, stride, offset); // draw

            const primitiveType = getPrimitiveType(gl, type);
            offset = 0;
            const count = vertices.length / 2;
            gl.drawArrays(primitiveType, offset, count); // update frame stats

            vertexCount += vertices.length;
          });
        }); // clear debug info

        overlay.replaceChildren();
        this.debugInfo.style.display = 'none';
        this.statsWidget.style.display = 'none'; // draw debug tile boundaries

        if (mapOptions.debug) {
          this.debugInfo.style.display = 'block';
          this.statsWidget.style.display = 'block';
          tilesInView.forEach(tile => {
            // todo: move up in other tile loop
            const colorLocation = gl.getUniformLocation(program, "u_color");
            gl.uniform4fv(colorLocation, [1, 0, 0, 1]);
            const positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            const tileVertices = geometryToVertices(tilebelt__default["default"].tileToGeoJSON(tile));
            gl.bufferData(gl.ARRAY_BUFFER, tileVertices, gl.STATIC_DRAW); // setup position attribute

            const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
            gl.enableVertexAttribArray(positionAttributeLocation); // tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)

            const size = 2;
            const dataType = gl.FLOAT;
            const normalize = false;
            const stride = 0;
            let offset = 0;
            gl.vertexAttribPointer(positionAttributeLocation, size, dataType, normalize, stride, offset); // draw

            const primitiveType = gl.LINES;
            offset = 0;
            const count = tileVertices.length / 2;
            gl.drawArrays(primitiveType, offset, count); // draw tile labels

            const tileCoordinates = tilebelt__default["default"].tileToGeoJSON(tile).coordinates;
            const topLeft = tileCoordinates[0][0];
            const [x, y] = MercatorCoordinate.fromLngLat(topLeft);
            const [clipX, clipY] = glMatrix.vec3.transformMat3([], [x, y, 1], viewProjectionMat);
            const wx = (1 + clipX) / pixelRatio * canvas.width;
            const wy = (1 - clipY) / pixelRatio * canvas.height;
            const div = document.createElement("div");
            div.className = "tile-label";
            div.style.left = wx + 8 + "px";
            div.style.top = wy + 8 + "px";
            div.appendChild(document.createTextNode(tile.join('/')));
            overlay.appendChild(div);
          }); // capture stats

          this.frameStats = {
            vertices: vertexCount,
            elapsed: performance.now() - start
          };
          stats.end();
        }

        window.requestAnimationFrame(this.draw); // call next loop
      });

      _defineProperty(this, "setupDOM", () => {
        // create canvas
        const canvas = document.createElement('canvas');
        const canvasId = "WebGLMap-canvas-".concat(this.mapOptions.id);
        canvas.setAttribute('id', canvasId);
        canvas.setAttribute('width', this.mapOptions.width);
        canvas.setAttribute('height', this.mapOptions.height);
        this.canvas = canvas; // create overlay (for tile debugging)

        const overlay = document.createElement('div');
        const overlayId = "WebGLMap-overlay-".concat(this.mapOptions.id);
        overlay.setAttribute('id', overlayId);
        this.overlay = overlay; // create div for debug info

        const debugInfo = document.createElement('div');
        const debugInfoId = "WebGLMap-debugInfo-".concat(this.mapOptions.id);
        debugInfo.setAttribute('id', debugInfoId);
        this.debugInfo = debugInfo; // create style tag

        const style = document.createElement('style');
        style.appendChild(document.createTextNode("\n      #".concat(canvasId, " {\n        position: absolute;\n        width: ").concat(this.mapOptions.width, "px;\n        height: ").concat(this.mapOptions.height, "px;\n        top: 0;\n        left: 0;\n        background: transparent;\n      }\n\n      #").concat(canvasId, ":hover {\n        cursor: grab;\n      }\n\n      #").concat(overlayId, " {\n        position: absolute;\n        width: ").concat(this.mapOptions.width, "px;\n        height: ").concat(this.mapOptions.height, "px;\n        top: 0;\n        left: 0;\n        overflow: hidden;\n        user-select: none;\n      }\n\n      #").concat(overlayId, " .tile-label {\n        color: red;\n        position: absolute;\n        z-index: 1000;\n      }\n\n      #").concat(debugInfoId, " {\n        position: absolute;\n        bottom: 0;\n        left: 0;\n        background: transparent;\n        padding: 10px;\n        font-size: 10px;\n        white-space: pre;\n      }\n    "))); // create wrapper

        const wrapper = document.createElement('div');
        const wrapperId = "WebGLMap-wrapper-".concat(this.mapOptions.id);
        wrapper.setAttribute('id', wrapperId);
        wrapper.setAttribute('class', 'WebGLMap-wrapper');
        wrapper.style.position = 'relative';
        wrapper.style.overflow = 'hidden';
        wrapper.style.width = this.mapOptions.width + 'px';
        wrapper.style.height = this.mapOptions.height + 'px';
        wrapper.appendChild(overlay);
        wrapper.appendChild(canvas);
        wrapper.appendChild(debugInfo); // append elements to DOM

        const el = document.getElementById(this.mapOptions.id);
        el.appendChild(wrapper);
        el.appendChild(style);

        if (this.mapOptions.debug) {
          this.stats.showPanel(0);
          this.statsWidget = this.stats.dom;
          this.statsWidget.style.position = 'absolute';
          wrapper.appendChild(this.statsWidget);
        }
      });

      _defineProperty(this, "updateDebugInfo", () => {
        const {
          x,
          y,
          zoom
        } = this.camera;
        const [lng, lat] = MercatorCoordinate.fromXY([x, y]);
        const text = ["center: [".concat(lng, ", ").concat(lat, "]"), "zoom: ".concat(zoom)];
        this.debugInfo.innerHTML = text.join('\n');
      });

      _defineProperty(this, "getMapInfo", () => {
        return {
          tiles: this.tiles,
          frameStats: this.frameStats
        };
      });

      this.mapOptions = Object.assign(defaultOptions, _options); // setup stats for debugging

      this.stats = new Stats__default["default"](); // init tile fields

      this.tiles = {}; // cached tile data

      this.tilesInView = []; // current visible tiles

      this.tileWorker = new Worker(new URL('./workers/tile-worker.js', (document.currentScript && document.currentScript.src || new URL('webgl-map.js', document.baseURI).href)));
      this.tileWorker.onmessage = this.handleTileWorker;
      this.tileWorker.onerror = this.handleTileWorkerError; // setup camera

      const [_x, _y] = MercatorCoordinate.fromLngLat(this.mapOptions.center);
      this.camera = {
        x: _x,
        y: _y,
        zoom: this.mapOptions.zoom
      };
      this.pixelRatio = 2; // setup canvas

      this.setupDOM(); // set initial states

      this.updateMatrix();
      this.updateTiles(); // setup event handlers

      this.canvas.addEventListener('mousedown', this.handlePan);
      this.canvas.addEventListener('wheel', this.handleZoom); // mobile event handlers

      const Hammer = require('hammerjs');

      this.hammer = new Hammer(this.canvas);
      this.hammer.get('pan').set({
        direction: Hammer.DIRECTION_ALL
      });
      this.hammer.on('panstart', this.handlePan);
      this.hammer.get('pinch').set({
        enable: true
      });
      this.hammer.on('pinch', this.handleZoom); // get GL context

      const _gl = this.canvas.getContext('webgl');

      _gl.viewport(0, 0, _gl.canvas.width, _gl.canvas.height); // compile shaders


      const vertexShader = createShader(_gl, _gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(_gl, _gl.FRAGMENT_SHADER, fragmentShaderSource); // setup program

      const _program = createProgram(_gl, vertexShader, fragmentShader);

      _gl.clear(_gl.COLOR_BUFFER_BIT);

      _gl.useProgram(_program); // save gl references


      this.gl = _gl;
      this.program = _program;
      this.draw(); // start render loop
    }

  }

  return WebGLMap;

})(axios, Protobuf, earcut, tilebelt, vectorTile, glMatrix, Stats);
