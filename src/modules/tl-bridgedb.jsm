// Copyright (c) 2019, The Tor Project, Inc.
// See LICENSE for licensing information.
//
// vim: set sw=2 sts=2 ts=8 et syntax=javascript:

/*************************************************************************
 * Tor Launcher BridgeDB Communication Module
 * https://github.com/isislovecruft/bridgedb/#accessing-the-moat-interface
 *************************************************************************/

let EXPORTED_SYMBOLS = [ "TorLauncherBridgeDB" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Subprocess.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "TorLauncherUtil",
                          "resource://torlauncher/modules/tl-util.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "TorLauncherLogger",
                          "resource://torlauncher/modules/tl-logger.jsm");

let TorLauncherBridgeDB =  // Public
{
  get isMoatConfigured()
  {
    let pref = _MoatRequestor.prototype.kPrefMoatService;
    return !!TorLauncherUtil.getCharPref(pref);
  },

  // Returns an _MoatRequestor object.
  createMoatRequestor: function()
  {
    return new _MoatRequestor();
  },

  // Extended Error object which is used when we have a numeric code and
  // a text error message.
  error: function(aCode, aMessage)
  {
    this.code = aCode;
    this.message = aMessage;
  },

  errorCodeBadCaptcha: 419
};

TorLauncherBridgeDB.error.prototype = Error.prototype;  // subclass Error

Object.freeze(TorLauncherBridgeDB);


function _MoatRequestor()
{
}

_MoatRequestor.prototype =
{
  kMaxResponseLength: 1024 * 400,
  kMoatContentType: "application/vnd.api+json",
  kMoatVersion: "0.1.0",
  kPrefBridgeDBFront: "extensions.torlauncher.bridgedb_front",
  kPrefBridgeDBReflector: "extensions.torlauncher.bridgedb_reflector",
  kPrefMoatService: "extensions.torlauncher.moat_service",
  kMoatFetchURLPath: "/fetch",
  kMoatFetchRequestType: "client-transports",
  kMoatFetchResponseType: "moat-challenge",
  kMoatCheckURLPath: "/check",
  kMoatCheckRequestType: "moat-solution",
  kMoatCheckResponseType: "moat-bridges",

  kMozProxyTypeSocks4: "socks4",
  kMozProxyTypeSocks5: "socks",

  kStateIdle: 0,
  kStateWaitingForVersion: 1,
  kStateWaitingForProxyDone: 2,
  kStateWaitingForCMethod: 3,
  kStateWaitingForCMethodsDone: 4,
  kStateInitialized: 5,

  mState: this.kStateIdle,

  mMeekTransport: undefined,
  mLocalProxyURL: undefined,
  mMeekFront: undefined,  // Frontend server, if we are using one.
  mMeekClientEscapedArgs: undefined,
  mMeekClientProcess: undefined,
  mMeekClientStdoutBuffer: undefined,
  mMeekClientProxyType: undefined,  // kMozProxyTypeSocks4 or kMozProxyTypeSocks5
  mMeekClientIP: undefined,
  mMeekClientPort: undefined,
  mMoatResponseListener: undefined,
  mUserCanceled: false,

  // Returns a promise.
  init: function(aProxyURL, aMeekTransport, aMeekClientPath, aMeekClientArgs)
  {
    this.mMeekTransport = aMeekTransport;
    this.mLocalProxyURL = aProxyURL;
    return this._startMeekClient(aMeekClientPath, aMeekClientArgs);
  },

  close: function()
  {
    if (this.mMeekClientProcess)
    {
      this.mMeekClientProcess.kill();
      this.mMeekClientProcess = undefined;
    }
  },

  // Public function: request bridges via Moat.
  // Returns a promise that is fulfilled with an object that contains:
  //   transport
  //   captchaImage
  //   challenge
  //
  // aTransports is an array of transport strings. Supported values:
  //   "vanilla"
  //   "obfs3"
  //   "obfs4"
  //   "scramblesuit"
  fetchBridges: function(aTransports)
  {
    this.mUserCanceled = false;
    if (!this.mMeekClientProcess)
      return this._meekClientNotRunningError();

    let requestObj = {
      data: [{
        version: this.kMoatVersion,
        type: this.kMoatFetchRequestType,
        supported: aTransports
      }]
    };
    return this._sendMoatRequest(requestObj, false);
  },

  // Public function: check CAPTCHA and retrieve bridges via Moat.
  // Returns a promise that is fulfilled with an object that contains:
  //   bridges          // an array of strings (bridge lines)
  finishFetch: function(aTransport, aChallenge, aSolution)
  {
    this.mUserCanceled = false;
    if (!this.mMeekClientProcess)
      return this._meekClientNotRunningError();

    let requestObj = {
      data: [{
        id: "2",
        type: this.kMoatCheckRequestType,
        version: this.kMoatVersion,
        transport: aTransport,
        challenge: aChallenge,
        solution: aSolution,
        qrcode: "false"
      }]
    };
    return this._sendMoatRequest(requestObj, true);
  },

  // Returns true if a promise is pending (which will be rejected), e.g.,
  // if a network request is active or we are inside init().
  cancel: function()
  {
    this.mUserCanceled = true;
    if (this.mMoatResponseListener)
      return this.mMoatResponseListener.cancelMoatRequest();

    if (this.mState != this.kStateInitialized)
    {
      // close() will kill the meek client process, which will cause
      // initialization to fail.
      this.close();
      return true;
    }

    return false;
  },

  // Returns a rejected promise.
  _meekClientNotRunningError()
  {
    return Promise.reject(new Error("The meek client exited unexpectedly."));
  },

  // Returns a promise.
  _startMeekClient: function(aMeekClientPath, aMeekClientArgs)
  {
    let workDir = TorLauncherUtil.getTorFile("pt-startup-dir", false);
    if (!workDir)
      return Promise.reject(new Error("Missing pt-startup-dir."));

    // Ensure that we have an absolute path for the meek client program.
    // This is necessary because Subprocess.call() checks for the existence
    // of the file before it changes to the startup (working) directory.
    let meekClientPath;
    let re = (TorLauncherUtil.isWindows) ?  /^[A-Za-z]:\\/ : /^\//;
    if (re.test(aMeekClientPath))
    {
      meekClientPath = aMeekClientPath; // We already have an absolute path.
    }
    else
    {
      let f = workDir.clone();
      f.appendRelativePath(aMeekClientPath);
      meekClientPath = f.path;
    }

    // Construct the per-connection arguments.
    this.mMeekClientEscapedArgs = "";
    let meekReflector = TorLauncherUtil.getCharPref(this.kPrefBridgeDBReflector);
    if (meekReflector)
    {
      this.mMeekClientEscapedArgs += "url=";
      this.mMeekClientEscapedArgs += this._escapeArgValue(meekReflector);
    }
    this.mMeekFront = TorLauncherUtil.getCharPref(this.kPrefBridgeDBFront);
    if (this.mMeekFront)
    {
      if (this.mMeekClientEscapedArgs.length > 0)
        this.mMeekClientEscapedArgs += ';';
      this.mMeekClientEscapedArgs += "front=";
      this.mMeekClientEscapedArgs += this._escapeArgValue(this.mMeekFront);
    }

    // Setup environment and start the meek client process.
    let ptStateDir = TorLauncherUtil.getTorFile("tordatadir", false);
    let meekHelperProfileDir = TorLauncherUtil.getTorFile("pt-profiles-dir",
                                                          true);
    if (!ptStateDir || !meekHelperProfileDir)
    {
      let msg = TorLauncherUtil.getLocalizedString("datadir_missing");
      return Promise.reject(new Error(msg));
    }
    ptStateDir.append("pt_state");  // Match what tor uses.

    meekHelperProfileDir.appendRelativePath("profile.moat-http-helper");

    let envAdditions = { TOR_PT_MANAGED_TRANSPORT_VER: "1",
                         TOR_PT_STATE_LOCATION: ptStateDir.path,
                         TOR_PT_EXIT_ON_STDIN_CLOSE: "1",
                         TOR_PT_CLIENT_TRANSPORTS: this.mMeekTransport,
                         TOR_BROWSER_MEEK_PROFILE: meekHelperProfileDir.path };
    if (this.mLocalProxyURL)
      envAdditions.TOR_PT_PROXY = this.mLocalProxyURL;

    TorLauncherLogger.log(3, "starting " + meekClientPath + " in "
                          + workDir.path);
    TorLauncherLogger.log(3, "args " + JSON.stringify(aMeekClientArgs));
    TorLauncherLogger.log(3, "env additions " + JSON.stringify(envAdditions));
    TorLauncherLogger.log(3, "per-connection args \"" +
                             this.mMeekClientEscapedArgs + "\"");
    let opts = { command: meekClientPath,
                 arguments: aMeekClientArgs,
                 workdir: workDir.path,
                 environmentAppend: true,
                 environment: envAdditions,
                 stderr: "pipe" };
    return Subprocess.call(opts)
      .then(aProc =>
      {
        this.mMeekClientProcess = aProc;
        aProc.wait()
          .then(aExitObj =>
          {
            this.mMeekClientProcess = undefined;
            TorLauncherLogger.log(3, "The meek client exited");
          });

          this.mState = this.kStateWaitingForVersion;
          TorLauncherLogger.log(3, "The meek client process has been started");
          this._startStderrLogger();
          return this._meekClientHandshake(aProc);
      });
  }, // _startMeekClient

  // Escape aValue per section 3.5 of the PT specification:
  //   First the "<Key>=<Value>" formatted arguments MUST be escaped,
  //   such that all backslash, equal sign, and semicolon characters
  //   are escaped with a backslash.
  _escapeArgValue: function(aValue)
  {
    if (!aValue)
      return "";

    let rv = aValue.replace(/\\/g, "\\\\");
    rv = rv.replace(/=/g, "\\=");
    rv = rv.replace(/;/g, "\\;");
    return rv;
  },

  // Returns a promise that is resolved when the PT handshake finishes.
  _meekClientHandshake: function(aMeekClientProc)
  {
    return new Promise((aResolve, aReject) =>
    {
      this._startStdoutRead(aResolve, aReject);
    });
  },

  _startStdoutRead: function(aResolve, aReject)
  {
    if (!this.mMeekClientProcess)
      throw new Error("No meek client process.");

    let readPromise = this.mMeekClientProcess.stdout.readString();
    readPromise
      .then(aStr =>
      {
        if (!aStr || (aStr.length == 0))
        {
          let err = "The meek client exited unexpectedly during the pluggable transport handshake.";
          TorLauncherLogger.log(3, err);
          throw new Error(err);
        }

        TorLauncherLogger.log(2, "meek client stdout: " + aStr);
        if (!this.mMeekClientStdoutBuffer)
          this.mMeekClientStdoutBuffer = aStr;
        else
          this.mMeekClientStdoutBuffer += aStr;

        if (this._processStdoutLines())
        {
          aResolve();
        }
        else
        {
          // The PT handshake has not finished yet. Read more data.
          this._startStdoutRead(aResolve, aReject);
        }
      })
      .catch(aErr =>
      {
        aReject(this.mUserCanceled ? Cr.NS_ERROR_ABORT : aErr);
      });
  }, // _startStdoutRead

  _startStderrLogger: function()
  {
    if (!this.mMeekClientProcess)
      return;

    let readPromise = this.mMeekClientProcess.stderr.readString();
    readPromise
      .then(aStr =>
      {
        if (aStr)
        {
          TorLauncherLogger.log(5, "meek client stderr: " + aStr);
          this._startStderrLogger();
        }
      });
  }, // _startStderrLogger

  // May throw. Returns true when the PT handshake is complete.
  // Conforms to the parent process role of the PT protocol.
  // See: https://gitweb.torproject.org/torspec.git/tree/pt-spec.txt
  _processStdoutLines: function()
  {
    if (!this.mMeekClientStdoutBuffer)
      throw new Error("The stdout buffer is missing.");

    let idx = this.mMeekClientStdoutBuffer.indexOf('\n');
    while (idx >= 0)
    {
      let line = this.mMeekClientStdoutBuffer.substring(0, idx);
      let tokens = line.split(' ');
      this.mMeekClientStdoutBuffer =
                            this.mMeekClientStdoutBuffer.substring(idx + 1);
      idx = this.mMeekClientStdoutBuffer.indexOf('\n');

      // Per the PT specification, unknown keywords are ignored.
      let keyword = tokens[0];
      let errMsg;
      switch (this.mState) {
        case this.kStateWaitingForVersion:
          if (keyword == "VERSION")
          {
            if (this.mLocalProxyURL)
              this.mState = this.kStateWaitingForProxyDone;
            else
              this.mState = this.kStateWaitingForCMethod;
          }
          else if (keyword == "VERSION-ERROR")
          {
            throw new Error("Unsupported pluggable transport version.");
          }
          break;
        case this.kStateWaitingForProxyDone:
          if ((keyword == "ENV-ERROR") || (keyword == "PROXY-ERROR"))
            throw new Error(line);

          if ((keyword == "PROXY") &&
              (tokens.length > 1) && (tokens[1] == "DONE"))
          {
            this.mState = this.kStateWaitingForCMethod;
          }
          break;
        case this.kStateWaitingForCMethod:
          if (keyword == "ENV-ERROR")
            throw new Error(line);

          if (keyword == "CMETHOD")
          {
            if (tokens.length != 4)
            {
              errMsg = "Invalid CMETHOD response (too few parameters).";
            }
            else if (tokens[1] != this.mMeekTransport)
            {
              errMsg = "Unexpected transport " + tokens[1]
                       + " in CMETHOD response.";
            }
            else
            {
              let proxyType = tokens[2];
              if (proxyType == "socks5")
              {
                this.mMeekClientProxyType = this.kMozProxyTypeSocks5;
              }
              else if ((proxyType == "socks4a") || (proxyType == "socks4"))
              {
                this.mMeekClientProxyType = this.kMozProxyTypeSocks4;
              }
              else
              {
                errMsg = "Unexpected proxy type " + proxyType +
                         " in CMETHOD response.";
                break;
              }
              let addrPort = tokens[3];
              let colonIdx = addrPort.indexOf(':');
              if (colonIdx < 1)
              {
                errMsg = "Missing port in CMETHOD response.";
              }
              else
              {
                this.mMeekClientIP = addrPort.substring(0, colonIdx);
                this.mMeekClientPort =
                                parseInt(addrPort.substring(colonIdx + 1));
              }
            }
          }
          else if (keyword == "CMETHOD-ERROR")
          {
            if (tokens.length < 3)
            {
              errMsg = "Invalid CMETHOD-ERROR response (too few parameters).";
            }
            else
            {
              errMsg = tokens[1] + " not available: "
                       + tokens.slice(2).join(' ');
            }
          }
          else if ((keyword == "CMETHODS") && (tokens.length > 1) &&
                   (tokens[1] == "DONE"))
          {
            this.mState = this.kStateInitialized;
          }
          break;
      }

      if (errMsg)
        throw new Error(errMsg);
    }

    if (this.mState == this.kStateInitialized)
    {
      TorLauncherLogger.log(2, "meek client proxy type: "
                            + this.mMeekClientProxyType);
      TorLauncherLogger.log(2, "meek client proxy IP: "
                            + this.mMeekClientIP);
      TorLauncherLogger.log(2, "meek client proxy port: "
                            + this.mMeekClientPort);
    }

    return (this.mState == this.kStateInitialized);
  }, // _processStdoutLines

  // Returns a promise.
  // Based on meek/firefox/components/main.js
  _sendMoatRequest: function(aRequestObj, aIsCheck)
  {
    // Include arguments per section 3.5 of the PT specification:
    //   Lastly the arguments are transmitted when making the outgoing
    //   connection using the authentication mechanism specific to the
    //   SOCKS protocol version.
    //
    //    - In the case of SOCKS 4, the concatenated argument list is
    //      transmitted in the "USERID" field of the "CONNECT" request.
    //
    //    - In the case of SOCKS 5, the parent process must negotiate
    //      "Username/Password" authentication [RFC1929], and transmit
    //      the arguments encoded in the "UNAME" and "PASSWD" fields.
    //
    //      If the encoded argument list is less than 255 bytes in
    //      length, the "PLEN" field must be set to "1" and the "PASSWD"
    //      field must contain a single NUL character.

    let userName = "";
    let password = undefined;
    if (this.mMeekClientProxyType == this.kMozProxyTypeSocks4)
    {
      userName = this.mMeekClientEscapedArgs;
    }
    else
    {
      if (this.mMeekClientEscapedArgs.length <= 255)
      {
        userName = this.mMeekClientEscapedArgs;
        password = "\x00";
      }
      else
      {
        userName = this.mMeekClientEscapedArgs.substring(0, 255);
        password = this.mMeekClientEscapedArgs.substring(255);
      }
    }

    let proxyPS = Cc["@mozilla.org/network/protocol-proxy-service;1"]
                  .getService(Ci.nsIProtocolProxyService);
    let flags = Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST;
    let noTimeout = 0xFFFFFFFF; // UINT32_MAX
    let proxyInfo = proxyPS.newProxyInfoWithAuth(this.mMeekClientProxyType,
                              this.mMeekClientIP, this.mMeekClientPort,
                              userName, password, undefined, undefined,
                              flags, noTimeout, undefined);
    let uriStr = TorLauncherUtil.getCharPref(this.kPrefMoatService);
    if (!uriStr)
    {
      return Promise.reject(
                  new Error("Missing value for " + this.kPrefMoatService));
    }

    uriStr += (aIsCheck) ? this.kMoatCheckURLPath : this.kMoatFetchURLPath;
    let uri = Services.io.newURI(uriStr);

    // There does not seem to be a way to directly create an nsILoadInfo from
    // JavaScript, so we create a throw away non-proxied channel to get one.
    let loadInfo = Services.io.newChannelFromURI(uri, undefined,
                        Services.scriptSecurityManager.getSystemPrincipal(),
                        undefined,
                        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL,
                        Ci.nsIContentPolicy.TYPE_OTHER).loadInfo;
    let httpHandler = Services.io.getProtocolHandler("http")
                                 .QueryInterface(Ci.nsIHttpProtocolHandler);
    let ch = httpHandler.newProxiedChannel(uri, proxyInfo, 0, undefined,
                                 loadInfo).QueryInterface(Ci.nsIHttpChannel);

    // Remove unwanted HTTP headers and set request parameters.
    let headers = [];
    ch.visitRequestHeaders({visitHeader: function(aKey, aValue) {
        headers.push(aKey); }});
    headers.forEach(aKey =>
      {
        if (aKey !== "Host")
          ch.setRequestHeader(aKey, "", false);
      });

    // BridgeDB expects to receive an X-Forwarded-For header. If we are
    // not using domain fronting (e.g., in a test setup), include a fake
    // header value.
    if (!this.mMeekFront)
      ch.setRequestHeader("X-Forwarded-For", "1.2.3.4", false);

    // Arrange for the POST data to be sent.
    let requestData = JSON.stringify(aRequestObj);
    let inStream = Cc["@mozilla.org/io/string-input-stream;1"]
                   .createInstance(Ci.nsIStringInputStream);
    inStream.setData(requestData, requestData.length);
    let upChannel = ch.QueryInterface(Ci.nsIUploadChannel);
    upChannel.setUploadStream(inStream, this.kMoatContentType,
                              requestData.length);
    ch.requestMethod = "POST";

    return new Promise((aResolve, aReject) =>
      {
        this.mMoatResponseListener =
            new _MoatResponseListener(this, ch, aIsCheck, aResolve, aReject);
        TorLauncherLogger.log(1, "Moat JSON request: " + requestData);
        ch.asyncOpen(this.mMoatResponseListener, ch);
      });
  } // _sendMoatRequest
};


// _MoatResponseListener is an HTTP stream listener that knows how to
// process Moat /fetch and /check responses.
function _MoatResponseListener(aRequestor, aChannel, aIsCheck,
                               aResolve, aReject)
{
  this.mRequestor = aRequestor;
  this.mChannel = aChannel;
  this.mIsCheck = aIsCheck;
  this.mResolveCallback = aResolve;
  this.mRejectCallback = aReject;
}


_MoatResponseListener.prototype =
{
  mRequestor: undefined,
  mChannel: undefined,
  mIsCheck: false,
  mResolveCallback: undefined,
  mRejectCallback: undefined,
  mResponseLength: 0,
  mResponseBody: undefined,

  onStartRequest: function(aRequest)
  {
    this.mResponseLength = 0;
    this.mResponseBody = "";
  },

  onStopRequest: function(aRequest, aStatus)
  {
    this.mChannel = undefined;

    if (!Components.isSuccessCode(aStatus))
    {
      this.mRejectCallback(new TorLauncherBridgeDB.error(aStatus,
                        TorLauncherUtil.getLocalizedStringForError(aStatus)));
      return;
    }

    let statusCode, msg;
    try
    {
      statusCode = aRequest.responseStatus;
      if (aRequest.responseStatusText)
        msg = statusCode + " " + aRequest.responseStatusText;
    }
    catch (e) {}

    TorLauncherLogger.log(3, "Moat response HTTP status: " + statusCode);
    if (statusCode != 200)
    {
      this.mRejectCallback(new TorLauncherBridgeDB.error(statusCode, msg));
      return;
    }

    TorLauncherLogger.log(1, "Moat JSON response: " + this.mResponseBody);

    try
    {
      // Parse the response. We allow response.data to be an array or object.
      let response = JSON.parse(this.mResponseBody);
      if (response.data && Array.isArray(response.data))
        response.data = response.data[0];

      let errCode = 400;
      let errStr;
      if (!response.data)
      {
        if (response.errors && Array.isArray(response.errors))
        {
          errCode = response.errors[0].code;
          errStr = response.errors[0].detail;
          if (this.mIsCheck && (errCode == 404))
            errStr = TorLauncherUtil.getLocalizedString("no_bridges_available");
        }
        else
        {
          errStr = "missing data in Moat response";
        }
      }
      else if (response.data.version !== this.mRequestor.kMoatVersion)
      {
        errStr = "unexpected version";
      }

      if (errStr)
        this.mRejectCallback(new TorLauncherBridgeDB.error(errCode, errStr));
      else if (!this.mIsCheck)
        this._parseFetchResponse(response);
      else
        this._parseCheckResponse(response);
    }
    catch(e)
    {
      TorLauncherLogger.log(3, "received invalid JSON: " + e);
      this.mRejectCallback(e);
    }
  }, // onStopRequest

  onDataAvailable: function(aRequest, aStream, aSrcOffset, aLength)
  {
    TorLauncherLogger.log(2, "Moat onDataAvailable: " + aLength + " bytes");
    if ((this.mResponseLength + aLength) > this.mRequestor.kMaxResponseLength)
    {
      aRequest.cancel(Cr.NS_ERROR_FAILURE);
      this.mChannel = undefined;
      this.mRejectCallback(new TorLauncherBridgeDB.error(500,
                                                  "Moat response too large"));
      return;
    }

    this.mResponseLength += aLength;
    let scriptableStream =  Cc["@mozilla.org/scriptableinputstream;1"]
                             .createInstance(Ci.nsIScriptableInputStream);
    scriptableStream.init(aStream);
    this.mResponseBody += scriptableStream.read(aLength);
  },

  cancelMoatRequest: function()
  {
    let didCancel = false;
    let rv = Cr.NS_ERROR_ABORT;
    if (this.mChannel)
    {
      this.mChannel.cancel(rv);
      this.mChannel = undefined;
      didCancel = true;
    }

    this.mRejectCallback(rv);
    return didCancel;
  },

  _parseFetchResponse: function(aResponse)
  {
    /*
     * Expected response if successful:
     * {
     *   "data": {
     *     "id": "1",
     *     "type": "moat-challenge",
     *     "version": "0.1.0",
     *     "transport": TRANSPORT,
     *     "image": CAPTCHA,
     *     "challenge": CHALLENGE
     *    }
     * }
     *
     * If there is no overlap between the type of bridge we requested and
     * the transports which BridgeDB supports, the response is the same except
     * the transport property will contain an array of supported transports:
     *     ...
     *     "transport": [ "TRANSPORT", "TRANSPORT", ... ],
     *     ...
     */

    // We do not check aResponse.id because it may vary.
    let errStr;
    if (aResponse.data.type !== this.mRequestor.kMoatFetchResponseType)
      errStr = "unexpected response type";
    else if (!aResponse.data.transport)
      errStr = "missing transport";
    else if (!aResponse.data.challenge)
      errStr = "missing challenge";
    else if (!aResponse.data.image)
      errStr = "missing CAPTCHA image";

    if (errStr)
    {
      this.mRejectCallback(new TorLauncherBridgeDB.error(500, errStr));
    }
    else
    {
      let imageURI = "data:image/jpeg;base64,"
                     + encodeURIComponent(aResponse.data.image);
      // If there was no overlap between the bridge type we requested and what
      // BridgeDB has, we use the first type that BridgeDB can provide.
      let t = aResponse.data.transport;
      if (Array.isArray(t))
        t = t[0];
      this.mResolveCallback({ captchaImage: imageURI,
                              transport: t,
                              challenge: aResponse.data.challenge });
    }
  }, // _parseFetchResponse

  _parseCheckResponse: function(aResponse)
  {
    /*
     * Expected response if successful:
     * {
     *   "data": {
     *     "id": "3",
     *     "type": "moat-bridges",
     *     "version": "0.1.0",
     *     "bridges": [ "BRIDGE_LINE", ... ],
     *     "qrcode": "QRCODE"
     *   }
     * }
     */

    // We do not check aResponse.id because it may vary.
    // To be robust, we treat a zero-length bridge array the same as the 404
    // error (no bridges available), which is handled inside onStopRequest().
    let errStr;
    if (aResponse.data.type !== this.mRequestor.kMoatCheckResponseType)
      errStr = "unexpected response type";
    else if (!aResponse.data.bridges || (aResponse.data.bridges.length == 0))
      errStr = TorLauncherUtil.getLocalizedString("no_bridges_available");

    if (errStr)
      this.mRejectCallback(new TorLauncherBridgeDB.error(500, errStr));
    else
      this.mResolveCallback({ bridges: aResponse.data.bridges });
  } // _parseCheckResponse
};
