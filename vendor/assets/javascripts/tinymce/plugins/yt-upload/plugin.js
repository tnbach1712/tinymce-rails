var STATUS_POLLING_INTERVAL_MILLIS = 60 * 1000; // One minute.

/*
Copyright 2015 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v2/files/';


/**
 * Helper for implementing retries with backoff. Initial retry
 * delay is 1 second, increasing by 2x (+jitter) for subsequent retries
 *
 * @constructor
 */
var RetryHandler = function () {
  this.interval = 1000; // Start at one second
  this.maxInterval = 60 * 1000; // Don't wait longer than a minute 
};

/**
 * Invoke the function after waiting
 *
 * @param {function} fn Function to invoke
 */
RetryHandler.prototype.retry = function (fn) {
  setTimeout(fn, this.interval);
  this.interval = this.nextInterval_();
};

/**
 * Reset the counter (e.g. after successful request.)
 */
RetryHandler.prototype.reset = function () {
  this.interval = 1000;
};

/**
 * Calculate the next wait time.
 * @return {number} Next wait interval, in milliseconds
 *
 * @private
 */
RetryHandler.prototype.nextInterval_ = function () {
  var interval = this.interval * 2 + this.getRandomInt_(0, 1000);
  return Math.min(interval, this.maxInterval);
};

/**
 * Get a random int in the range of min to max. Used to add jitter to wait times.
 *
 * @param {number} min Lower bounds
 * @param {number} max Upper bounds
 * @private
 */
RetryHandler.prototype.getRandomInt_ = function (min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
};


/**
 * Helper class for resumable uploads using XHR/CORS. Can upload any Blob-like item, whether
 * files or in-memory constructs.
 *
 * @example
 * var content = new Blob(["Hello world"], {"type": "text/plain"});
 * var uploader = new MediaUploader({
 *   file: content,
 *   token: accessToken,
 *   onComplete: function(data) { ... }
 *   onError: function(data) { ... }
 * });
 * uploader.upload();
 *
 * @constructor
 * @param {object} options Hash of options
 * @param {string} options.token Access token
 * @param {blob} options.file Blob-like item to upload
 * @param {string} [options.fileId] ID of file if replacing
 * @param {object} [options.params] Additional query parameters
 * @param {string} [options.contentType] Content-type, if overriding the type of the blob.
 * @param {object} [options.metadata] File metadata
 * @param {function} [options.onComplete] Callback for when upload is complete
 * @param {function} [options.onProgress] Callback for status for the in-progress upload
 * @param {function} [options.onError] Callback if upload fails
 */
var MediaUploader = function (options) {
  var noop = function () { };
  this.file = options.file;
  this.contentType = options.contentType || this.file.type || 'application/octet-stream';
  this.metadata = options.metadata || {
    'title': this.file.name,
    'mimeType': this.contentType
  };
  this.token = options.token;
  this.onComplete = options.onComplete || noop;
  this.onProgress = options.onProgress || noop;
  this.onError = options.onError || noop;
  this.offset = options.offset || 0;
  this.chunkSize = options.chunkSize || 0;
  this.retryHandler = new RetryHandler();

  this.url = options.url;
  if (!this.url) {
    var params = options.params || {};
    params.uploadType = 'resumable';
    this.url = this.buildUrl_(options.fileId, params, options.baseUrl);
  }
  this.httpMethod = options.fileId ? 'PUT' : 'POST';
};

/**
 * Initiate the upload.
 */
MediaUploader.prototype.upload = function () {
  var self = this;
  var xhr = new XMLHttpRequest();

  xhr.open(this.httpMethod, this.url, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + this.token);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-Upload-Content-Length', this.file.size);
  xhr.setRequestHeader('X-Upload-Content-Type', this.contentType);

  xhr.onload = function (e) {
    if (e.target.status < 400) {
      var location = e.target.getResponseHeader('Location');
      this.url = location;
      this.sendFile_();
    } else {
      this.onUploadError_(e);
    }
  }.bind(this);
  xhr.onerror = this.onUploadError_.bind(this);
  xhr.send(JSON.stringify(this.metadata));
};

/**
 * Send the actual file content.
 *
 * @private
 */
MediaUploader.prototype.sendFile_ = function () {
  var content = this.file;
  var end = this.file.size;

  if (this.offset || this.chunkSize) {
    // Only bother to slice the file if we're either resuming or uploading in chunks
    if (this.chunkSize) {
      end = Math.min(this.offset + this.chunkSize, this.file.size);
    }
    content = content.slice(this.offset, end);
  }

  var xhr = new XMLHttpRequest();
  xhr.open('PUT', this.url, true);
  xhr.setRequestHeader('Content-Type', this.contentType);
  xhr.setRequestHeader('Content-Range', 'bytes ' + this.offset + '-' + (end - 1) + '/' + this.file.size);
  xhr.setRequestHeader('X-Upload-Content-Type', this.file.type);
  if (xhr.upload) {
    xhr.upload.addEventListener('progress', this.onProgress);
  }
  xhr.onload = this.onContentUploadSuccess_.bind(this);
  xhr.onerror = this.onContentUploadError_.bind(this);
  xhr.send(content);
};

/**
 * Query for the state of the file for resumption.
 *
 * @private
 */
MediaUploader.prototype.resume_ = function () {
  var xhr = new XMLHttpRequest();
  xhr.open('PUT', this.url, true);
  xhr.setRequestHeader('Content-Range', 'bytes */' + this.file.size);
  xhr.setRequestHeader('X-Upload-Content-Type', this.file.type);
  if (xhr.upload) {
    xhr.upload.addEventListener('progress', this.onProgress);
  }
  xhr.onload = this.onContentUploadSuccess_.bind(this);
  xhr.onerror = this.onContentUploadError_.bind(this);
  xhr.send();
};

/**
 * Extract the last saved range if available in the request.
 *
 * @param {XMLHttpRequest} xhr Request object
 */
MediaUploader.prototype.extractRange_ = function (xhr) {
  var range = xhr.getResponseHeader('Range');
  if (range) {
    this.offset = parseInt(range.match(/\d+/g).pop(), 10) + 1;
  }
};

/**
 * Handle successful responses for uploads. Depending on the context,
 * may continue with uploading the next chunk of the file or, if complete,
 * invokes the caller's callback.
 *
 * @private
 * @param {object} e XHR event
 */
MediaUploader.prototype.onContentUploadSuccess_ = function (e) {
  if (e.target.status == 200 || e.target.status == 201) {
    this.onComplete(e.target.response);
  } else if (e.target.status == 308) {
    this.extractRange_(e.target);
    this.retryHandler.reset();
    this.sendFile_();
  }
};

/**
 * Handles errors for uploads. Either retries or aborts depending
 * on the error.
 *
 * @private
 * @param {object} e XHR event
 */
MediaUploader.prototype.onContentUploadError_ = function (e) {
  if (e.target.status && e.target.status < 500) {
    this.onError(e.target.response);
  } else {
    this.retryHandler.retry(this.resume_.bind(this));
  }
};

/**
 * Handles errors for the initial request.
 *
 * @private
 * @param {object} e XHR event
 */
MediaUploader.prototype.onUploadError_ = function (e) {
  this.onError(e.target.response); // TODO - Retries for initial upload
};

/**
 * Construct a query string from a hash/object
 *
 * @private
 * @param {object} [params] Key/value pairs for query string
 * @return {string} query string
 */
MediaUploader.prototype.buildQuery_ = function (params) {
  params = params || {};
  return Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
};

/**
 * Build the drive upload URL
 *
 * @private
 * @param {string} [id] File ID if replacing
 * @param {object} [params] Query parameters
 * @return {string} URL
 */
MediaUploader.prototype.buildUrl_ = function (id, params, baseUrl) {
  var url = baseUrl || DRIVE_UPLOAD_URL;
  if (id) {
    url += id;
  }
  var query = this.buildQuery_(params);
  if (query) {
    url += '?' + query;
  }
  return url;
};

/**
 * YouTube video uploader class
 *
 * @constructor
 */
var UploadVideo = function () {
  /**
   * The array of tags for the new YouTube video.
   *
   * @attribute tags
   * @type Array.<>
   * @default ['google-cors-upload']
   */
  this.tags = ['youtube-cors-upload'];


  /**
   * The numeric YouTube
   * [category id](https://developers.google.com/apis-explorer/#p/youtube/v3/youtube.videoCategories.list?part=snippet&regionCode=us).
   *
   * @attribute categoryId
   * @type number
   * @default 22
   */
  this.categoryId = 22;


  /**
   * The id of the new video.
   *
   * @attribute videoId
   * @type string
   * @default ''
   */
  this.videoId = '';


  this.uploadStartTime = 0;
};



UploadVideo.prototype.ready = function (accessToken) {
  this.accessToken = accessToken;
  gapi.auth.setToken({ access_token: accessToken })
  this.gapi = gapi;


  this.authenticated = true;
  this.gapi.client.request({
    path: '/youtube/v3/channels',
    params: {
      part: 'snippet',
      mine: true
    },
    callback: function (response) {
      if (response.error) {
        console.log(response.error.message);
      } else {
        $('#channel-name').text(response.items[0].snippet.title);
        $('#channel-thumbnail').attr('src', response.items[0].snippet.thumbnails.default.url);


        $('.pre-sign-in').hide();
        $('.post-sign-in').show();
      }
    }.bind(this)
  });
  $('#btn-upload-youtube').on("click", this.handleUploadClicked.bind(this));
  $('#btn-upload-youtube').on("click", function () {
    $('.during-upload').show()
  });
};


/**
 * Uploads a video file to YouTube.
 *
 * @method uploadFile
 * @param {object} file File object corresponding to the video to upload.
 */
UploadVideo.prototype.uploadFile = function (file, cb) {
  var metadata = {
    snippet: {
      title: $('.product-title').text().trim(),
      description: $('#description').text(),
      tags: $('#collapseTag').text().trim().split(","),
      categoryId: this.categoryId
    },
    status: {
      privacyStatus: 'public'
    }
  };
  console.log(metadata);
  var uploader = new MediaUploader({
    baseUrl: 'https://www.googleapis.com/upload/youtube/v3/videos',
    file: file,
    token: this.accessToken,
    metadata: metadata,
    params: {
      part: Object.keys(metadata).join(',')
    },
    onError: function (data) {
      var message = data;
      // Assuming the error is raised by the YouTube API, data will be
      // a JSON string with error.message set. That may not be the
      // only time onError will be raised, though.
      console.log(message)
      try {
        var errorResponse = JSON.parse(data);
        message = errorResponse.error.message;
      } finally {
        alert(message);        
      }
    }.bind(this),
    onProgress: function (data) {
      console.log(data)
      var currentTime = Date.now();
      var bytesUploaded = data.loaded;
      var totalBytes = data.total;
      // The times are in millis, so we need to divide by 1000 to get seconds.
      var bytesPerSecond = bytesUploaded / ((currentTime - this.uploadStartTime) / 1000);
      var estimatedSecondsRemaining = (totalBytes - bytesUploaded) / bytesPerSecond;
      var percentageComplete = (bytesUploaded * 100) / totalBytes;
      $('#upload-progress').attr({
        value: bytesUploaded,
        max: totalBytes
      });
      $('#percent-transferred').text(percentageComplete);
      $('#bytes-transferred').text(bytesUploaded);
      $('#total-bytes').text(totalBytes);
      $('.during-upload').show();
    }.bind(this),
    onComplete: function (data) {
      var uploadResponse = JSON.parse(data);
      this.videoId = uploadResponse.id;
      $('#video-id').text(this.videoId);
      $('.post-upload').show();
      this.pollForVideoStatus();
      cb(this)
    }.bind(this)
  });
  // This won't correspond to the *exact* start of the upload, but it should be close enough.
  this.uploadStartTime = Date.now();
  console.log('uploaded')
  uploader.upload();
};


UploadVideo.prototype.handleUploadClicked = function () {
  $('#btn-upload-youtube').attr('disabled', true);


  this.uploadFile($('#note-dialog-video-file').get(0).files[0]);
};


UploadVideo.prototype.pollForVideoStatus = function () {
  this.gapi.client.request({
    path: '/youtube/v3/videos',
    params: {
      part: 'status,player',
      id: this.videoId
    },
    callback: function (response) {
      if (response.error) {
        // The status polling failed.
        console.log(response.error.message);
        setTimeout(this.pollForVideoStatus.bind(this), STATUS_POLLING_INTERVAL_MILLIS);
      } else {
        var uploadStatus = response.items[0].status.uploadStatus;
        switch (uploadStatus) {
          // This is a non-final status, so we need to poll again.
          case 'uploaded':
            $('#post-upload-status').append('<li>Upload status: ' + uploadStatus + '</li>');
            const e = $.Event('paste');
            console.log(this)
            $('.note-video-url').val('https://www.youtube.com/watch?v=' + this.videoId).trigger(e);
            setTimeout(this.pollForVideoStatus.bind(this), STATUS_POLLING_INTERVAL_MILLIS);
            break;
          // The video was successfully transcoded and is available.
          case 'processed':
            $('#player').append(response.items[0].player.embedHtml);
            $('#post-upload-status').append('<li>Final status.</li>');
            break;
          // All other statuses indicate a permanent transcoding failure.
          default:
            $('#post-upload-status').append('<li>Transcoding failed.</li>');
            break;
        }
      }
    }.bind(this)
  });
};



tinymce.PluginManager.add('yt-upload', function (editor, url) {
  var uploadVideo = new UploadVideo()
  var openDialog = function () {
    console.log(editor)
    return editor.windowManager.open({
      title: 'Embed Video',
      body: {
        type: 'panel',
        items: [
          {
            type: 'input',
            name: 'url',
            label: 'Url video (Youtube, Instagram, Vimeo, Vine, QQ, Facebook)'
          }, {
            type: 'htmlpanel',
            html: "<p> Hoặc </p>"
          },
          {
            type: 'urlinput',
            name: 'fileupload',
            filetype: 'media',
            label: 'Upload from local.'
          },
          {
            type: 'button', // component type
            text: 'Upload Youtube',
            primary: true,
            name: 'upload-youtube',
            disabled: true
          },
          {
            type: 'htmlpanel', // component type
            html: '<div class="during-upload" style="display: none;" > <p><span id="percent-transferred"></span>%  (<span id="bytes-transferred"></span>/<span id="total-bytes"></span> bytes)</p> <progress id="upload-progress" max="1" value="0" style="height: 5px; width: 100%;"></progress> </div>'
          }
        ]
      },
      buttons: [
        {
          type: 'cancel',
          text: 'Close'
        },
        {
          type: 'submit',
          text: 'Save', disable: true,
          primary: true
        }
      ],
      initialData: {
        
      },
      onSubmit: function (api) {
        var data = api.getData();
        var html = createVideoNode(data.url)
        editor.insertContent(html.outerHTML);
        api.close();
      },
      onChange: function (api) {
        var data = api.getData();
        api.enable("upload-youtube")
      },
      onAction: function (api, details) {
        var data = api.getData();
        uploadVideo.ready(editor.settings.ytAccessToken)
        uploadVideo.uploadFile(data.fileupload.meta.file, function (data) {
          console.log(data)
          api.setData({ url: "https://www.youtube.com/watch?v=" + data.videoId })
        })

        $('.during-upload').show()
      }
    });
  };
  var createVideoNode = function (url) {
    // video url patterns(youtube, instagram, vimeo, dailymotion, youku, mp4, ogg, webm)
    const ytRegExp = /\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w|-]{11})(?:(?:[\?&]t=)(\S+))?$/;
    const ytRegExpForStart = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
    const ytMatch = url.match(ytRegExp);


    const igRegExp = /(?:www\.|\/\/)instagram\.com\/p\/(.[a-zA-Z0-9_-]*)/;
    const igMatch = url.match(igRegExp);


    const vRegExp = /\/\/vine\.co\/v\/([a-zA-Z0-9]+)/;
    const vMatch = url.match(vRegExp);


    const vimRegExp = /\/\/(player\.)?vimeo\.com\/([a-z]*\/)*(\d+)[?]?.*/;
    const vimMatch = url.match(vimRegExp);


    const dmRegExp = /.+dailymotion.com\/(video|hub)\/([^_]+)[^#]*(#video=([^_&]+))?/;
    const dmMatch = url.match(dmRegExp);


    const youkuRegExp = /\/\/v\.youku\.com\/v_show\/id_(\w+)=*\.html/;
    const youkuMatch = url.match(youkuRegExp);


    const qqRegExp = /\/\/v\.qq\.com.*?vid=(.+)/;
    const qqMatch = url.match(qqRegExp);


    const qqRegExp2 = /\/\/v\.qq\.com\/x?\/?(page|cover).*?\/([^\/]+)\.html\??.*/;
    const qqMatch2 = url.match(qqRegExp2);


    const mp4RegExp = /^.+.(mp4|m4v)$/;
    const mp4Match = url.match(mp4RegExp);


    const oggRegExp = /^.+.(ogg|ogv)$/;
    const oggMatch = url.match(oggRegExp);


    const webmRegExp = /^.+.(webm)$/;
    const webmMatch = url.match(webmRegExp);


    const fbRegExp = /(?:www\.|\/\/)facebook\.com\/([^\/]+)\/videos\/([0-9]+)/;
    const fbMatch = url.match(fbRegExp);


    let $video;
    if (ytMatch && ytMatch[1].length === 11) {
      const youtubeId = ytMatch[1];
      var start = 0;
      if (typeof ytMatch[2] !== 'undefined') {
        const ytMatchForStart = ytMatch[2].match(ytRegExpForStart);
        if (ytMatchForStart) {
          for (var n = [3600, 60, 1], i = 0, r = n.length; i < r; i++) {
            start += (typeof ytMatchForStart[i + 1] !== 'undefined' ? n[i] * parseInt(ytMatchForStart[i + 1], 10) : 0);
          }
        }
      }
      $video = $('<iframe>')
        .attr('frameborder', 0)
        .attr('src', '//www.youtube.com/embed/' + youtubeId + (start > 0 ? '?start=' + start : ''))
        .attr('width', '640').attr('height', '360');
    } else if (igMatch && igMatch[0].length) {
      $video = $('<iframe>')
        .attr('frameborder', 0)
        .attr('src', 'https://instagram.com/p/' + igMatch[1] + '/embed/')
        .attr('width', '612').attr('height', '710')
        .attr('scrolling', 'no')
        .attr('allowtransparency', 'true');
    } else if (vMatch && vMatch[0].length) {
      $video = $('<iframe>')
        .attr('frameborder', 0)
        .attr('src', vMatch[0] + '/embed/simple')
        .attr('width', '600').attr('height', '600')
        .attr('class', 'vine-embed');
    } else if (vimMatch && vimMatch[3].length) {
      $video = $('<iframe webkitallowfullscreen mozallowfullscreen allowfullscreen>')
        .attr('frameborder', 0)
        .attr('src', '//player.vimeo.com/video/' + vimMatch[3])
        .attr('width', '640').attr('height', '360');
    } else if (dmMatch && dmMatch[2].length) {
      $video = $('<iframe>')
        .attr('frameborder', 0)
        .attr('src', '//www.dailymotion.com/embed/video/' + dmMatch[2])
        .attr('width', '640').attr('height', '360');
    } else if (youkuMatch && youkuMatch[1].length) {
      $video = $('<iframe webkitallowfullscreen mozallowfullscreen allowfullscreen>')
        .attr('frameborder', 0)
        .attr('height', '498')
        .attr('width', '510')
        .attr('src', '//player.youku.com/embed/' + youkuMatch[1]);
    } else if ((qqMatch && qqMatch[1].length) || (qqMatch2 && qqMatch2[2].length)) {
      const vid = ((qqMatch && qqMatch[1].length) ? qqMatch[1] : qqMatch2[2]);
      $video = $('<iframe webkitallowfullscreen mozallowfullscreen allowfullscreen>')
        .attr('frameborder', 0)
        .attr('height', '310')
        .attr('width', '500')
        .attr('src', 'https://v.qq.com/iframe/player.html?vid=' + vid + '&amp;auto=0');
    } else if (mp4Match || oggMatch || webmMatch) {
      $video = $('<video controls>')
        .attr('src', url)
        .attr('width', '640').attr('height', '360');
    } else if (fbMatch && fbMatch[0].length) {
      $video = $('<iframe>')
        .attr('frameborder', 0)
        .attr('src', 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(fbMatch[0]) + '&show_text=0&width=560')
        .attr('width', '560').attr('height', '301')
        .attr('scrolling', 'no')
        .attr('allowtransparency', 'true');
    } else {
      // this is not a known video link. Now what, Cat? Now what?
      return false;
    }
    return $video[0];
  }
  // Add a button that opens a window
  editor.ui.registry.addButton('yt-upload', {
    text: '<i class="fa fa-youtube-play"></i>',
    onAction: function () {
      // Open window
      openDialog();
    }
  });


  // Adds a menu item, which can then be included in any menu via the menu/menubar configuration
  editor.ui.registry.addMenuItem('yt-upload', {
    text: 'Upload Youtube plugin',
    onAction: function () {
      // Open window
      openDialog();
    }
  });


  return {
    getMetadata: function () {
      return {
        name: "Upload Youtube plugin",
        url: "http://exampleplugindocsurl.com"
      };
    }
  };
});
