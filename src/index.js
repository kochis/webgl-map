import axios from 'axios';
import Protobuf from 'pbf';
import earcut from 'earcut';
import tilebelt from '@mapbox/tilebelt';
import { VectorTile } from '@mapbox/vector-tile';
import { vec3, mat3 } from 'gl-matrix';
import Stats from 'stats.js';

import { createShader, createProgram, getPrimitiveType } from './utils/webgl-utils';
import { fetchTile, geometryToVertices } from './utils/map-utils';
import MercatorCoordinate from './utils/mercator-coordinate';

////////////
// shaders
////////////
const vertexShaderSource = `
  attribute vec2 a_position;

  uniform mat3 u_matrix;

  void main() {
    gl_PointSize = 3.0;

    vec2 position = (u_matrix * vec3(a_position, 1)).xy;
    gl_Position = vec4(position, 0, 1);
  }
`;

const fragmentShaderSource = `
  precision mediump float;

  uniform vec4 u_color;

  void main() {
    gl_FragColor = u_color;
  }
`;

//////////////
// constants
//////////////
const TILE_SIZE = 512;
const MAX_TILE_ZOOM = 14;

const defaultOptions = {
  width: 512,
  height: 512,
  center: [-73.9834558, 40.6932723], // BROOKLYN
  minZoom: 0,
  maxZoom: 18,
  zoom: 13,
  tileBuffer: 1,
  disabledLayers: [],
  debug: false,
};

class WebGLMap {
  constructor(options = {}) {
    this.mapOptions = Object.assign(defaultOptions, options);

    // setup stats for debugging
    this.stats = new Stats();

    // init tile fields
    this.tiles = {}; // cached tile data
    this.tilesInView = []; // current visible tiles
    this.tileWorker = new Worker(new URL('./workers/tile-worker.js', import.meta.url));
    this.tileWorker.onmessage = this.handleTileWorker;
    this.tileWorker.onerror = this.handleTileWorkerError;

    // setup camera
    const [x, y] = MercatorCoordinate.fromLngLat(this.mapOptions.center);
    this.camera = {
      x,
      y,
      zoom: this.mapOptions.zoom,
    };
    this.pixelRatio = 2;

    // setup canvas
    this.setupDOM();

    // set initial states
    this.updateMatrix();
    this.updateTiles();

    // setup event handlers
    this.canvas.addEventListener('mousedown', this.handlePan);
    this.canvas.addEventListener('wheel', this.handleZoom);

    // mobile event handlers
    const Hammer = require('hammerjs');
    this.hammer = new Hammer(this.canvas);
    this.hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL });
    this.hammer.on('panstart', this.handlePan);
    this.hammer.get('pinch').set({ enable: true });
    this.hammer.on('pinch', this.handleZoom);

    // get GL context
    const gl = this.canvas.getContext('webgl');
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    // compile shaders
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    // setup program
    const program = createProgram(gl, vertexShader, fragmentShader);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    // create buffers
    this.positionBuffer = gl.createBuffer();

    // save gl references
    this.gl = gl;
    this.program = program;

    this.draw(); // start render loop
  }

  setOptions = (options = {}) => {
    this.mapOptions = {
      ...this.mapOptions,
      ...options,
    };
  }

  // update map view based camera state
  updateMatrix = () => {
    // update camera matrix
    const { camera } = this;
    const zoomScale = 1 / Math.pow(2, camera.zoom); // inverted
    const widthScale = TILE_SIZE / this.canvas.width;
    const heightScale = TILE_SIZE / this.canvas.height;

    const cameraMat = mat3.create();
    mat3.translate(cameraMat, cameraMat, [camera.x, camera.y]);
    mat3.scale(cameraMat, cameraMat, [zoomScale / widthScale, zoomScale / heightScale]);

    // update view projection matrix
    const mat = mat3.create();
    const viewMat = mat3.invert([], cameraMat);
    const viewProjectionMat = mat3.multiply([], mat, viewMat);
    this.viewProjectionMat = viewProjectionMat;

    if (this.mapOptions.debug) {
      this.updateDebugInfo();
    }
  }

  updateTiles = () => {
    // update visible tiles based on viewport
    const bbox = this.getBounds();
    const z = Math.min(Math.trunc(this.camera.zoom), MAX_TILE_ZOOM);
    const minTile = tilebelt.pointToTile(bbox[0], bbox[3], z);
    const maxTile = tilebelt.pointToTile(bbox[2], bbox[1], z);

    // tiles visible in viewport
    this.tilesInView = [];
    const [minX, maxX] = [Math.max(minTile[0], 0), maxTile[0]];
    const [minY, maxY] = [Math.max(minTile[1], 0), maxTile[1]];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        this.tilesInView.push([x, y, z]);
      }
    }

    // get additional tiles to buffer (based on buffer setting)
    this.bufferedTiles = [];
    const { tileBuffer } = this.mapOptions;
    for (let bufX = minX - tileBuffer; bufX <= maxX + tileBuffer; bufX++) {
      for (let bufY = minY - tileBuffer; bufY <= maxY + tileBuffer; bufY++) {
        this.bufferedTiles.push([bufX, bufY, z]);

        // get parents 2 levels up
        this.bufferedTiles.push(tilebelt.getParent([bufX, bufY, z]));
        this.bufferedTiles.push(tilebelt.getParent(tilebelt.getParent([bufX, bufY, z])));
      }
    }

    // remove duplicates
    let tilesToLoad = [
      ...new Set([
        ...this.tilesInView.map(t => t.join('/')),
        ...this.bufferedTiles.map(t => t.join('/'))
      ])
    ];

    // make sure tiles are in range
    tilesToLoad = tilesToLoad.filter((tile) => {
      const [x, y, z] = tile.split('/').map(Number);
      const N = Math.pow(2, z);
      const validX = x >= 0 && x < N;
      const validY = y >= 0 && y < N;
      const validZ = z >= 0 && z <= MAX_TILE_ZOOM;
      return validX && validY && validZ;
    });
    const inViewLookup = new Set(this.tilesInView.map(t => t.join('/')));

    // tile fetching options
    const { layers, tileServerURL: url } = this.mapOptions;

    // load tiles from tilerServer
    tilesToLoad.forEach((tile) => {
      if (this.tiles[tile]) {
        return; // already loaded, no need to fetch
      }
      // temp hold for request
      this.tiles[tile] = [];

      // hand off buffered tiles to worker for fetching & processing
      this.tileWorker.postMessage({ tile, layers, url });
    });
  }

  // if current tile is not loaded, just render scaled versions of parent or children
  getPlaceholderTile = (tile) => {
    // use parent if available
    const parent = tilebelt.getParent(tile)?.join('/');
    const parentFeatureSet = this.tiles[parent];
    if (parentFeatureSet?.length > 0) {
      return parentFeatureSet;
    }

    // use whatever children are available
    const childFeatureSets = [];
    const children = (tilebelt.getChildren(tile) || []).map(t => t.join('/'));
    children.forEach((child) => {
      const featureSet = this.tiles[child];
      if (featureSet?.length > 0) {
        childFeatureSets.push(...featureSet);
      }
    });
    return childFeatureSets;
  }

  // update tiles with data from worker
  handleTileWorker = (workerEvent) => {
    const { tile, tileData } = workerEvent.data;
    this.tiles[tile] = tileData;
  }

  // errors from tile worker
  handleTileWorkerError = (error) => {
    console.error('Uncaught worker error.', error);
  }

  // handle drag changes while mouse is still down
  // "mousemove" or "pan"
  handleMove = (moveEvent) => {
    const [x, y] = this.getClipSpacePosition(moveEvent);

    // compute the previous position in world space
    const [preX, preY] = vec3.transformMat3(
      [],
      [this.startX, this.startY, 0],
      mat3.invert([], this.viewProjectionMat)
    );

    // compute the new position in world space
    const [postX, postY] = vec3.transformMat3(
      [],
      [x, y, 0],
      mat3.invert([], this.viewProjectionMat)
    );

    // move that amount, because how much the position changes depends on the zoom level
    const deltaX = preX - postX;
    const deltaY = preY - postY;
    if (isNaN(deltaX) || isNaN(deltaY)) {
      return; // abort
    }

    // only update within world limits
    this.camera.x += deltaX;
    this.camera.y += deltaY;

    // update view matrix
    this.updateMatrix();

    // prevent further pan if at limits
    if (this.atLimits()) {
      this.camera.x -= deltaX; // undo
      this.camera.y -= deltaY; // undo
      this.updateMatrix();
      return; // abort
    }

    // update tiles
    this.updateTiles();

    // save current pos for next movement
    this.startX = x;
    this.startY = y;
  }

  // handle dragging the map position (panning)
  // "mousedown" OR "panstart"
  handlePan = (startEvent) => {
    startEvent.preventDefault();

    // get position of initial drag
    let [startX, startY] = this.getClipSpacePosition(startEvent);
    this.startX = startX;
    this.startY = startY;
    this.canvas.style.cursor = 'grabbing';

    // handle move events once started
    window.addEventListener('mousemove', this.handleMove);
    this.hammer.on('pan', this.handleMove);

    // clear on release
    const clear = (event) => {
      this.canvas.style.cursor = 'grab';

      window.removeEventListener('mousemove',this.handleMove);
      this.hammer.off('pan', this.handleMove);

      window.removeEventListener('mouseup', clear);
      this.hammer.off('panend', clear);
    };
    window.addEventListener('mouseup', clear);
    this.hammer.on('panend', clear);
  }

  // handle zooming
  handleZoom = (wheelEvent) => {
    wheelEvent.preventDefault();
    const [x, y] = this.getClipSpacePosition(wheelEvent);

    // get position before zooming
    const [preZoomX, preZoomY] = vec3.transformMat3(
      [],
      [x, y, 0],
      mat3.invert([], this.viewProjectionMat)
    );

    // update current zoom state
    const prevZoom = this.camera.zoom;
    const zoomDelta = -wheelEvent.deltaY * (1 / 300);
    this.camera.zoom += zoomDelta;
    this.camera.zoom = Math.max(this.mapOptions.minZoom, Math.min(this.camera.zoom, this.mapOptions.maxZoom));
    this.updateMatrix();

    // prevent further zoom if at limits
    if (this.atLimits()) {
      this.camera.zoom = prevZoom; // undo
      this.updateMatrix();
      return; // abort
    }

    // get new position after zooming
    const [postZoomX, postZoomY] = vec3.transformMat3(
      [],
      [x, y, 0],
      mat3.invert([], this.viewProjectionMat)
    );

    // camera needs to be moved the difference of before and after
    this.camera.x += preZoomX - postZoomX;
    this.camera.y += preZoomY - postZoomY;

    this.updateMatrix();
    this.updateTiles();
  }

  // from a given mouse position on the canvas, return the xy value in clip space
  getClipSpacePosition = (e) => {
    // get position from mouse or touch event
    const [x, y] = [
      e.center?.x || e.clientX,
      e.center?.y || e.clientY
    ];

    // get canvas relative css position
    const rect = this.canvas.getBoundingClientRect();
    const cssX = x - rect.left;
    const cssY = y - rect.top;

    // get normalized 0 to 1 position across and down canvas
    const normalizedX = cssX / this.canvas.clientWidth;
    const normalizedY = cssY / this.canvas.clientHeight;

    // convert to clip space
    const clipX = normalizedX *  2 - 1;
    const clipY = normalizedY * -2 + 1;

    return [clipX, clipY];
  }

  // get latLng bbox for current viewport
  getBounds = () => {
    const zoomScale = Math.pow(2, this.camera.zoom);

    // undo clip-space
    const px = (1 + this.camera.x) / this.pixelRatio;
    const py = (1 - this.camera.y) / this.pixelRatio;

    // get world coord in px
    const wx = px * TILE_SIZE;
    const wy = py * TILE_SIZE;

    // get zoom px
    const zx = wx * zoomScale;
    const zy = wy * zoomScale;

    // get bottom-left and top-right pixels
    let x1 = zx - (this.canvas.width / 2);
    let y1 = zy + (this.canvas.height / 2);
    let x2 = zx + (this.canvas.width / 2);
    let y2 = zy - (this.canvas.height / 2);

    // convert to world coords
    x1 = x1 / zoomScale / TILE_SIZE;
    y1 = y1 / zoomScale / TILE_SIZE;
    x2 = x2 / zoomScale / TILE_SIZE;
    y2 = y2 / zoomScale / TILE_SIZE;

    // get LngLat bounding box
    const bbox = [
      MercatorCoordinate.lngFromMercatorX(x1),
      MercatorCoordinate.latFromMercatorY(y1),
      MercatorCoordinate.lngFromMercatorX(x2),
      MercatorCoordinate.latFromMercatorY(y2)
    ];

    return bbox;
  }

  // check if map is at world limits
  // lng: -180 - 180
  // lat: -85.05 - 85.05
  atLimits = () => {
    const bbox = this.getBounds();
    return (
      bbox[0] <= -180 ||
      bbox[1] <= -85.05 ||
      bbox[2] >= 180 ||
      bbox[3] >= 85.05
    );
  }

  // re-draw the scene
  draw = () => {
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
      stats,
    } = this;

    // stats reporting
    let start = performance.now();
    let vertexCount = 0;
    if (mapOptions.debug) {
      stats.begin();
    }

    // set matrix uniform
    const matrixLocation = gl.getUniformLocation(program, "u_matrix");
    gl.uniformMatrix3fv(matrixLocation, false, viewProjectionMat);

    // render tiles
    tilesInView.forEach((tile) => {
      let featureSets = tiles[tile.join('/')];

      if (featureSets?.length === 0) {
        featureSets = this.getPlaceholderTile(tile);
      }

      (featureSets || []).forEach((featureSet) => {
        const { layer, type, vertices } = featureSet;

        if (mapOptions.disabledLayers.includes(layer)) {
          return;
        }

        const color = mapOptions.layers[layer].map((n) => n / 255); // RBGA to WebGL

        // set color uniform
        const colorLocation = gl.getUniformLocation(program, "u_color");
        gl.uniform4fv(colorLocation, color);

        // create buffer for vertices
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        // setup position attribute
        const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(positionAttributeLocation);

        // tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)
        const size = 2;
        const dataType = gl.FLOAT;
        const normalize = false;
        const stride = 0;
        let offset = 0; 
        gl.vertexAttribPointer(positionAttributeLocation, size, dataType, normalize, stride, offset);

        // draw
        const primitiveType = getPrimitiveType(gl, type);
        offset = 0;
        const count = vertices.length / 2;
        gl.drawArrays(primitiveType, offset, count);

        // update frame stats
        vertexCount += vertices.length;
      });
    });

    // clear debug info
    overlay.replaceChildren();
    this.debugInfo.style.display = 'none';
    this.statsWidget.style.display = 'none';

    // draw debug tile boundaries
    if (mapOptions.debug) {
      this.debugInfo.style.display = 'block';
      this.statsWidget.style.display = 'block';

      tilesInView.forEach((tile) => { // todo: move up in other tile loop
        const colorLocation = gl.getUniformLocation(program, "u_color");
        gl.uniform4fv(colorLocation, [1, 0, 0, 1]);

        const tileVertices = geometryToVertices(tilebelt.tileToGeoJSON(tile));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, tileVertices, gl.STATIC_DRAW);

        // setup position attribute
        const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(positionAttributeLocation);

        // tell the attribute how to get data out of positionBuffer (ARRAY_BUFFER)
        const size = 2;
        const dataType = gl.FLOAT;
        const normalize = false;
        const stride = 0;
        let offset = 0; 
        gl.vertexAttribPointer(positionAttributeLocation, size, dataType, normalize, stride, offset);

        // draw
        const primitiveType = gl.LINES;
        offset = 0;
        const count = tileVertices.length / 2;
        gl.drawArrays(primitiveType, offset, count);

        // draw tile labels
        const tileCoordinates = tilebelt.tileToGeoJSON(tile).coordinates;
        const topLeft = tileCoordinates[0][0];
        const [x, y] = MercatorCoordinate.fromLngLat(topLeft);

        const [clipX, clipY] = vec3.transformMat3(
          [],
          [x, y, 1],
          viewProjectionMat,
        );

        const wx = ((1 + clipX) / pixelRatio) * canvas.width;
        const wy = ((1 - clipY) / pixelRatio) * canvas.height;
        const div = document.createElement("div");
        div.className = "tile-label";
        div.style.left = (wx + 8) + "px";
        div.style.top  = (wy + 8) + "px";
        div.appendChild(document.createTextNode(tile.join('/')));
        overlay.appendChild(div);
      });

      // capture stats
      this.frameStats = {
        vertices: vertexCount,
        elapsed: performance.now() - start,
      }
      stats.end();
    }

    window.requestAnimationFrame(this.draw); // call next loop
  }

  // create DOM elements
  setupDOM = () => {
    // create canvas
    const canvas = document.createElement('canvas');
    const canvasId = `WebGLMap-canvas-${this.mapOptions.id}`;
    canvas.setAttribute('id', canvasId);
    canvas.setAttribute('width', this.mapOptions.width);
    canvas.setAttribute('height', this.mapOptions.height);
    this.canvas = canvas;

    // create overlay (for tile debugging)
    const overlay = document.createElement('div');
    const overlayId = `WebGLMap-overlay-${this.mapOptions.id}`;
    overlay.setAttribute('id', overlayId);
    this.overlay = overlay;

    // create div for debug info
    const debugInfo = document.createElement('div');
    const debugInfoId = `WebGLMap-debugInfo-${this.mapOptions.id}`;
    debugInfo.setAttribute('id', debugInfoId);
    this.debugInfo = debugInfo;

    // create style tag
    const style = document.createElement('style');
    style.appendChild(document.createTextNode(`
      #${canvasId} {
        position: absolute;
        width: ${this.mapOptions.width}px;
        height: ${this.mapOptions.height}px;
        top: 0;
        left: 0;
        background: transparent;
      }

      #${canvasId}:hover {
        cursor: grab;
      }

      #${overlayId} {
        position: absolute;
        width: ${this.mapOptions.width}px;
        height: ${this.mapOptions.height}px;
        top: 0;
        left: 0;
        overflow: hidden;
        user-select: none;
      }

      #${overlayId} .tile-label {
        color: red;
        position: absolute;
        z-index: 1000;
      }

      #${debugInfoId} {
        position: absolute;
        bottom: 0;
        left: 0;
        background: transparent;
        padding: 10px;
        font-size: 10px;
        white-space: pre;
      }
    `));

    // create wrapper
    const wrapper = document.createElement('div');
    const wrapperId = `WebGLMap-wrapper-${this.mapOptions.id}`;
    wrapper.setAttribute('id', wrapperId);
    wrapper.setAttribute('class', 'WebGLMap-wrapper');
    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    wrapper.style.width = this.mapOptions.width + 'px';
    wrapper.style.height = this.mapOptions.height + 'px';
    wrapper.appendChild(overlay);
    wrapper.appendChild(canvas);
    wrapper.appendChild(debugInfo);

    // append elements to DOM
    const el = document.getElementById(this.mapOptions.id);
    el.appendChild(wrapper);
    el.appendChild(style);

    if (this.mapOptions.debug) {
      this.stats.showPanel(0);
      this.statsWidget = this.stats.dom;
      this.statsWidget.style.position = 'absolute';
      wrapper.appendChild(this.statsWidget);
    }
  }

  updateDebugInfo = () => {
    const { x, y, zoom } = this.camera;
    const [lng, lat] = MercatorCoordinate.fromXY([x, y]);
    const text = [
      `center: [${lng}, ${lat}]`,
      `zoom: ${zoom}`
    ];
    this.debugInfo.innerHTML = text.join('\n');
  }

  // get stats from map
  getMapInfo = () => {
    return {
      tiles: this.tiles,
      frameStats: this.frameStats,
    }
  }
}

export default WebGLMap;
