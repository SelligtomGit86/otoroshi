package otoroshi.next.tunnel

import akka.actor.{Actor, ActorRef, PoisonPill, Props}
import akka.http.scaladsl.model.{HttpProtocols, Uri}
import akka.http.scaladsl.model.headers.RawHeader
import akka.http.scaladsl.model.ws.WebSocketRequest
import akka.stream.scaladsl.{Flow, Keep, Sink, Source, SourceQueueWithComplete}
import akka.stream.{Materializer, OverflowStrategy}
import akka.util.ByteString
import com.github.blemale.scaffeine.Scaffeine
import otoroshi.actions.ApiAction
import otoroshi.cluster.{ClusterMode, MemberView}
import otoroshi.env.Env
import otoroshi.models.{ApiKey, Target, TargetPredicate}
import otoroshi.next.plugins.api._
import otoroshi.next.proxy.{NgProxyEngineError, ProxyEngine, TunnelRequest}
import otoroshi.script.RequestHandler
import otoroshi.utils.http.MtlsConfig
import otoroshi.utils.http.RequestImplicits.EnhancedRequestHeader
import otoroshi.utils.syntax.implicits._
import play.api.{Configuration, Logger}
import play.api.http.HttpEntity
import play.api.http.websocket._
import play.api.libs.json.{Format, JsError, JsObject, JsResult, JsSuccess, JsValue, Json}
import play.api.libs.streams.ActorFlow
import play.api.libs.ws.WSCookie
import play.api.mvc._

import java.util.concurrent.atomic.{AtomicInteger, AtomicLong, AtomicReference}
import scala.collection.immutable
import scala.concurrent.duration.{DurationInt, DurationLong, FiniteDuration}
import scala.concurrent.{ExecutionContext, Future, Promise}
import scala.util.{Failure, Success, Try}

case class TunnelPluginConfig(tunnelId: String) extends NgPluginConfig {
  override def json: JsValue = Json.obj("tunnel_id" -> tunnelId)
}

object TunnelPluginConfig {
  val default = TunnelPluginConfig("default")
  def format = new Format[TunnelPluginConfig] {
    override def writes(o: TunnelPluginConfig): JsValue = o.json
    override def reads(json: JsValue): JsResult[TunnelPluginConfig] = Try {
      TunnelPluginConfig(
        tunnelId = json.select("tunnel_id").asString
      )
    } match {
      case Failure(exception) => JsError(exception.getMessage)
      case Success(value) => JsSuccess(value)
    }
  }
}

// TODO: TCP implementation to support SSE and websockets ??? or just improve the protocol to create source of bytestring
class TunnelPlugin extends NgBackendCall {

  private val logger = Logger("otoroshi-tunnel-plugin")

  override def useDelegates: Boolean                       = false
  override def multiInstance: Boolean                      = true
  override def core: Boolean                               = false
  override def name: String                                = "Remote tunnel calls"
  override def description: Option[String]                 =
    "This plugin can contact remote service using tunnels".some
  override def defaultConfigObject: Option[NgPluginConfig] = TunnelPluginConfig.default.some

  override def visibility: NgPluginVisibility    = NgPluginVisibility.NgUserLand
  override def categories: Seq[NgPluginCategory] = Seq(NgPluginCategory.Integrations)
  override def steps: Seq[NgStep]                = Seq(NgStep.CallBackend)

  override def callBackend(ctx: NgbBackendCallContext, delegates: () => Future[Either[NgProxyEngineError, BackendCallResponse]])(implicit env: Env, ec: ExecutionContext, mat: Materializer): Future[Either[NgProxyEngineError, BackendCallResponse]] = {
    val config = ctx.cachedConfig(internalName)(TunnelPluginConfig.format).getOrElse(TunnelPluginConfig.default)
    val tunnelId = config.tunnelId
    logger.debug(s"routing call through tunnel '${tunnelId}'")
    env.tunnelManager.sendRequest(tunnelId, ctx.request, ctx.rawRequest.remoteAddress, ctx.rawRequest.theSecured).map { result =>
      logger.debug(s"response from tunnel '${tunnelId}'")
      val setCookieHeader: Seq[WSCookie] = result.header.headers.getIgnoreCase("Set-Cookie").map { sc =>
        Cookies.decodeSetCookieHeader(sc)
      }.getOrElse(Seq.empty).map(_.wsCookie)
      Right(BackendCallResponse(
        NgPluginHttpResponse(
          status = result.header.status,
          headers = result.header.headers,
          cookies = setCookieHeader,
          body = result.body.dataStream,
        ), None
      ))
    }
  }
}

class TunnelAgent(env: Env) {

  private val logger = Logger("otoroshi-tunnel-agent")

  def start(): TunnelAgent = {
    env.configuration.getOptional[Configuration]("otoroshi.tunnels").map { config =>
      val genabled = config.getOptional[Boolean]("enabled").getOrElse(false)
      if (genabled) {
        config.subKeys.map { key =>
          (key, config.getOpt[Configuration](key))
        }.collect {
          case (key, Some(conf)) => (key, conf)
        }.map { case (key, conf) =>
          val enabled = conf.getOptional[Boolean]("enabled").getOrElse(false)
          if (enabled) {
            val tunnelId = conf.getOptional[String]("id").getOrElse(key)
            val name = conf.getOptional[String]("name").getOrElse("default")
            val url = conf.getOptional[String]("url").getOrElse("http://127.0.0.1:9999")
            val hostname = conf.getOptional[String]("host").getOrElse("otoroshi-api.oto.tools")
            val clientId = conf.getOptional[String]("clientId").getOrElse("client")
            val clientSecret = conf.getOptional[String]("clientSecret").getOrElse("secret")
            val ipAddress = conf.getOptional[String]("ipAddress")
            val tls = {
              val enabled =
                conf.getOptionalWithFileSupport[Boolean]("tls.mtls")
                  .orElse(conf.getOptionalWithFileSupport[Boolean]("tls.enabled"))
                  .getOrElse(false)
              if (enabled) {
                val loose        =
                  conf.getOptionalWithFileSupport[Boolean]("tls.loose").getOrElse(false)
                val trustAll     =
                  conf.getOptionalWithFileSupport[Boolean]("tls.trustAll").getOrElse(false)
                val certs        =
                  conf.getOptionalWithFileSupport[Seq[String]]("tls.certs").getOrElse(Seq.empty)
                val trustedCerts = conf
                  .getOptionalWithFileSupport[Seq[String]]("tls.trustedCerts")
                  .getOrElse(Seq.empty)
                MtlsConfig(
                  certs = certs,
                  trustedCerts = trustedCerts,
                  mtls = enabled,
                  loose = loose,
                  trustAll = trustAll
                ).some
              } else {
                None
              }
            }
            connect(tunnelId, name, url, hostname, clientId, clientSecret, ipAddress, tls, 200)
          }
        }
      }
    }
    this
  }

  private def connect(tunnelId: String, name: String, url: String, hostname: String, clientId: String, clientSecret: String, ipAddress: Option[String], tls: Option[MtlsConfig], waiting: Long): Future[Unit] = {

    implicit val ec = env.otoroshiExecutionContext
    implicit val mat = env.otoroshiMaterializer
    implicit val ev = env

    logger.info(s"connecting tunnel '${tunnelId}' ...")

    val promise = Promise[Unit]()
    val pingSource: Source[akka.http.scaladsl.model.ws.Message, _] = Source.tick(10.seconds, 10.seconds, ()).map(_ => PingMessage(Json.obj("tunnel_id" -> tunnelId, "type" -> "ping").stringify.byteString)).map { pm =>
      akka.http.scaladsl.model.ws.BinaryMessage.Strict(pm.data)
    }
    val queueRef = new AtomicReference[SourceQueueWithComplete[akka.http.scaladsl.model.ws.Message]]()
    val pushSource: Source[akka.http.scaladsl.model.ws.Message, SourceQueueWithComplete[akka.http.scaladsl.model.ws.Message]] = Source.queue[akka.http.scaladsl.model.ws.Message](512, OverflowStrategy.dropHead).mapMaterializedValue { q =>
      queueRef.set(q)
      q
    }
    val source: Source[akka.http.scaladsl.model.ws.Message, _] = pushSource.merge(pingSource, true)

    def handleRequest(rawRequest: ByteString): Unit = Try {
      val obj = Json.parse(rawRequest.toArray)
      val typ = obj.select("type").asString
      if (typ == "request") {
        val requestId: Long = obj.select("request_id").asLong
        logger.debug(s"got request from server on tunnel '${tunnelId}' - ${requestId}")
        val url = obj.select("url").asString
        val addr = obj.select("addr").asString
        val secured = obj.select("secured").asOpt[Boolean].getOrElse(false)
        val hasBody = obj.select("hasBody").asOpt[Boolean].getOrElse(false)
        val version = obj.select("version").asString
        val method = obj.select("method").asString
        val headers = obj.select("headers").asOpt[Map[String, String]].getOrElse(Map.empty)
        val cookies = obj.select("cookies").asOpt[Seq[JsObject]].map { arr =>
          arr.map { c =>
            Cookie(
              name = c.select("name").asString,
              value = c.select("value").asString,
              maxAge = c.select("maxAge").asOpt[Int],
              path = c.select("path").asString,
              domain = c.select("domain").asOpt[String],
              secure = c.select("secure").asOpt[Boolean].getOrElse(false),
              httpOnly = c.select("httpOnly").asOpt[Boolean].getOrElse(false),
              sameSite = None,
            )
          }
        }.getOrElse(Seq.empty)
        val certs = obj.select("client_cert_chain").asOpt[Seq[String]].map(_.map(_.trim.toCertificate))
        val body = obj.select("body").asOpt[String].map(b => ByteString(b).decodeBase64) match {
          case None => Source.empty[ByteString]
          case Some(b) => Source.single(b)
        }
        val engine = env.scriptManager.getAnyScript[RequestHandler](s"cp:${classOf[ProxyEngine].getName}").right.get
        val request = new TunnelRequest(
          reqId = requestId,
          version = version,
          method = method,
          body = body,
          _remoteUriStr = url,
          _remoteAddr = addr,
          _remoteSecured = secured,
          _remoteHasBody = hasBody,
          _headers = headers,
          cookies = Cookies(cookies),
          certs = certs,
        )
        engine.handle(request, _ => Results.InternalServerError("bad default routing").vfuture).map { result =>
          val ct = result.body.contentType
          val cl = result.body.contentLength
          val cookies = result.header.headers.getIgnoreCase("Cookie").map { c =>
            Cookies.decodeCookieHeader(c)
          }.getOrElse(Seq.empty)
          result.body.dataStream.runFold(ByteString.empty)(_ ++ _).map { br =>
            val resJson = Json.obj(
              "request_id" -> requestId,
              "type" -> "response",
              "status" -> result.header.status,
              "headers" -> (result.header.headers ++ Map.empty[String, String].applyOnWithOpt(ct) {
                case (headers, ctype) => headers ++ Map("Content-Type" -> ctype)
              }.applyOnWithOpt(cl) {
                case (headers, clength) => headers ++ Map("Content-Length" -> clength.toString)
              }),
              "cookies" -> cookies.map(_.json),
              "body" -> br.encodeBase64.utf8String
            )
            logger.debug(s"sending response back to server on tunnel '${tunnelId}' - ${requestId}")
            Option(queueRef.get()).foreach(queue => queue.offer(akka.http.scaladsl.model.ws.BinaryMessage.Streamed(resJson.stringify.byteString.chunks(16 * 1024))))
          }
        }
      }
    } match {
      case Failure(exception) => exception.printStackTrace()
      case Success(_) => ()
    }

    val userpwd = s"${clientId}:${clientSecret}".base64
    val uri = Uri(url + s"/api/tunnels/register?tunnel_id=${tunnelId}").copy(scheme = if (url.startsWith("https")) "wss" else "ws")
    val (fu, _) = env.Ws.ws(

      request = WebSocketRequest(
        uri = uri,
        extraHeaders = List(
          RawHeader("Host", hostname),
          RawHeader("Authorization", s"Basic ${userpwd}"),
          RawHeader(env.Headers.OtoroshiClientId, clientId),
          RawHeader(env.Headers.OtoroshiClientSecret, clientSecret),
        ),
        subprotocols = immutable.Seq.empty[String]
      ),
      targetOpt = Target(
        host = uri.authority.host.toString(),
        scheme = uri.scheme,
        protocol = HttpProtocols.`HTTP/1.1`,
        predicate = TargetPredicate.AlwaysMatch,
        ipAddress = ipAddress,
        mtlsConfig = tls.getOrElse(MtlsConfig()),
      ).some,
      clientFlow = Flow.fromSinkAndSource(
        Sink.foreach[akka.http.scaladsl.model.ws.Message] {
          case akka.http.scaladsl.model.ws.TextMessage.Strict(data) => logger.warn(s"invalid text message: '${data}'")
          case akka.http.scaladsl.model.ws.TextMessage.Streamed(source) => source.runFold("")(_ + _).map(b => logger.warn(s"invalid text message: '${b}'"))
          case akka.http.scaladsl.model.ws.BinaryMessage.Strict(data) => handleRequest(data)
          case akka.http.scaladsl.model.ws.BinaryMessage.Streamed(source) => source.runFold(ByteString.empty)(_ ++ _).map(b => handleRequest(b))
        },
        source,
      ).alsoTo(Sink.onComplete {
        case Success(e) =>
          logger.info(s"tunnel '${tunnelId}' disconnected, launching reconnection ...")
          timeout(waiting.millis).andThen { case _ =>
            connect(tunnelId, name, url, hostname, clientId, clientSecret, ipAddress, tls, waiting * 2)
          }
          promise.trySuccess(())
        case Failure(e) =>
          logger.error(s"tunnel '${tunnelId}' disconnected, launching reconnection ...", e)
          timeout(waiting.millis).andThen { case _ =>
            connect(tunnelId, name, url, hostname, clientId, clientSecret, ipAddress, tls, waiting * 2)
          }
          promise.trySuccess(())
      }),
      customizer = m => m
    )
    promise.future
  }

  private def timeout(duration: FiniteDuration): Future[Unit] = {
    val promise = Promise[Unit]
    env.otoroshiActorSystem.scheduler.scheduleOnce(duration) {
      promise.trySuccess(())
    }(env.otoroshiExecutionContext)
    promise.future
  }
}

class TunnelManager(env: Env) {

  import scala.jdk.CollectionConverters._

  private val tunnels = Scaffeine().maximumSize(10000).expireAfterWrite(10.minute).build[String, Seq[Tunnel]]()
  private val counter = new AtomicInteger(0)
  private val tunnelsEnabled = env.configuration.getOptional[Boolean]("otoroshi.tunnels.enabled").getOrElse(false)
  private val logger = Logger(s"otoroshi-tunnel-manager")

  private implicit val ec = env.otoroshiExecutionContext
  private implicit val ev = env

  def currentTunnels: Set[String] = tunnels.asMap().keySet.toSet

  private def whenEnabled(f: => Unit): Unit = {
    if (tunnelsEnabled) {
      f
    }
  }

  def start(): TunnelManager = this

  def closeTunnel(tunnelId: String): Unit = whenEnabled {
    //println("closing tunnel", tunnelId)
    tunnels.invalidate(tunnelId)
  }

  def registerTunnel(tunnelId: String, tunnel: Tunnel): Unit = whenEnabled {
    //println("registering tunnel", tunnelId)
    tunnels.getIfPresent(tunnelId) match {
      case None => tunnels.put(tunnelId, Seq(tunnel))
      case Some(ts) => tunnels.put(tunnelId, ts :+ tunnel)
    }
  }

  def tunnelHeartBeat(tunnelId: String): Unit = whenEnabled {
    tunnels.getIfPresent(tunnelId).foreach(ts => tunnels.put(tunnelId, ts)) // yeah, i know :(
  }

  def sendLocalRequestRaw(tunnelId: String, request: JsValue): Future[Result] = {
    if (tunnelsEnabled) {
      tunnels.getIfPresent(tunnelId) match {
        case None => Results.NotFound(Json.obj("error" -> s"missing tunnel '${tunnelId}'")).vfuture
        case Some(tunnels) => {
          val index = counter.incrementAndGet() % (if (tunnels.nonEmpty) tunnels.size else 1)
          val tunnel = tunnels.apply(index)
          tunnel.actor match {
            case None => Results.NotFound(Json.obj("error" -> s"missing tunnel connection for tunnel '${tunnelId}'")).vfuture
            case Some(tunnel) => tunnel.sendRequestRaw(request)
          }
        }
      }
    } else {
      Results.InternalServerError(Json.obj("error" -> s"tunnels not enabled")).vfuture
    }
  }

  def sendRequest(tunnelId: String, request: NgPluginHttpRequest, addr: String, secured: Boolean): Future[Result] = {
    if (tunnelsEnabled) {
      tunnels.getIfPresent(tunnelId) match {
        case None => {
          env.datastores.clusterStateDataStore.getMembers().flatMap { members =>
            members.filterNot(_.memberType != ClusterMode.Worker).find(_.tunnels.contains(tunnelId)) match {
              case None => Results.NotFound(Json.obj("error" -> s"missing tunnel '${tunnelId}'")).vfuture
              case Some(member) => forwardRequest(tunnelId, request, addr, secured, member)
            }
          }
        }
        case Some(tunnels) => {
          val index = counter.incrementAndGet() % (if (tunnels.nonEmpty) tunnels.size else 1)
          val tunnel = tunnels.apply(index)
          tunnel.actor match {
            case None => Results.NotFound(Json.obj("error" -> s"missing tunnel connection for tunnel '${tunnelId}'")).vfuture
            case Some(tunnel) => tunnel.sendRequest(request, addr, secured)
          }
        }
      }
    } else {
      Results.InternalServerError(Json.obj("error" -> s"tunnels not enabled")).vfuture
    }
  }

  private def forwardRequest(tunnelId: String, request: NgPluginHttpRequest, addr: String, secured: Boolean, member: MemberView): Future[Result] = {
    val requestId: Long = counter.incrementAndGet()
    logger.debug(s"forwarding request for '${tunnelId}' - ${requestId} to ${member.name}")
    val requestJson = TunnelActor.requestToJson(request, addr, secured, requestId).stringify.byteString
    val url = Uri(env.clusterConfig.leader.urls.head)
    val ipAddress = member.location
    val service = env.proxyState.service(env.backOfficeServiceId).get
    env.Ws.akkaUrlWithTarget(s"${url.toString()}/api/tunnels/${tunnelId}/relay", Target(
      host = url.authority.toString(),
      scheme = url.scheme,
      ipAddress = ipAddress.some
    )).withMethod("POST")
      .withRequestTimeout(service.clientConfig.globalTimeout.milliseconds)
      .withHttpHeaders(
        env.Headers.OtoroshiClientId -> env.clusterConfig.leader.clientId,
        env.Headers.OtoroshiClientSecret -> env.clusterConfig.leader.clientSecret,
        "Content-Type" -> "application/json"
      )
      .withBody(requestJson)
      .execute()
      .map { resp =>
        if (resp.status == 200) {
          TunnelActor.responseToResult(resp.json)
        } else {
          logger.error(s"error while forwarding tunnel request to '${tunnelId}' - ${resp.status} - ${resp.headers} - ${resp.body}")
          Results.InternalServerError(Json.obj("error" -> s"error while handling request"))
        }
      }
  }
}

class TunnelController(val ApiAction: ApiAction, val cc: ControllerComponents)(implicit val env: Env)
  extends AbstractController(cc) {

  implicit lazy val ec  = env.otoroshiExecutionContext
  implicit lazy val mat = env.otoroshiMaterializer
  implicit lazy val factory = env.otoroshiActorSystem

  private val tunnelsEnabled = env.configuration.getOptional[Boolean]("otoroshi.tunnels.enabled").getOrElse(false)

  private def validateRequest(request: RequestHeader): Option[ApiKey] = env.backOfficeApiKey.some // TODO: actual validation

  def infos = ApiAction {
    Ok(Json.obj(
      "domain" -> env.domain,
      "scheme" -> env.exposedRootScheme,
      "exposed_port_http" -> env.exposedHttpPortInt,
      "exposed_port_https" -> env.exposedHttpsPortInt,
    ))
  }

  def tunnelRelay(tunnelId: String) = ApiAction.async(parse.json) { ctx =>
    env.tunnelManager.sendLocalRequestRaw(tunnelId, ctx.request.body)
  }

  def tunnelEndpoint() = WebSocket.acceptOrResult[Message, Message] { request =>
    if (tunnelsEnabled) {
      val tunnelId: String = request.getQueryString("tunnel_id").get
      val reversePingPong: Boolean = request.getQueryString("pong_ping").getOrElse("false") == "true"
      validateRequest(request) match {
        case None => Left(Results.Unauthorized(Json.obj("error" -> "unauthorized"))).vfuture
        case Some(_) =>
          val holder = new Tunnel()
          val flow = ActorFlow.actorRef { out =>
            TunnelActor.props(out, tunnelId, request, reversePingPong, env)(r => holder.setActor(r))
          }
          holder.setFlow(flow)
          env.tunnelManager.registerTunnel(tunnelId, holder)
          flow.rightf
      }
    } else {
      Left(Results.NotFound(Json.obj("error" -> "resource not found"))).vfuture
    }
  }
}

class Tunnel() {
  private var _actor: TunnelActor = _
  private var _flow: Flow[Message, Message, _] = _
  def setActor(r: TunnelActor): Unit = _actor = r
  def setFlow(r: Flow[Message, Message, _]): Unit = _flow = r
  def actor: Option[TunnelActor] = Option(_actor)
  def flow: Option[Flow[Message, Message, _]] = Option(_flow)
}

object TunnelActor {
  def props(out: ActorRef, tunnelId: String, req: RequestHeader, reversePingPong: Boolean, env: Env)(f: TunnelActor => Unit): Props = {
    Props {
      val actor = new TunnelActor(out, tunnelId, req, reversePingPong, env)
      f(actor)
      actor
    }
  }

  def requestToJson(request: NgPluginHttpRequest, addr: String, secured: Boolean, requestId: Long): JsValue = {
    (request.json.asObject ++ Json.obj(
      "path" -> request.relativeUri,
      "request_id" -> requestId,
      "type" -> "request",
      "addr" -> addr,
      "secured" -> secured.toString,
      "hasBody" -> request.hasBody,
      "version" -> request.version,
    ))
  }

  def responseToResult(response: JsValue): Result = {
    val status = response.select("status").asInt
    val headers = response.select("headers").asOpt[Map[String, String]].getOrElse(Map.empty)
    val headersList: Seq[(String, String)] = headers.toSeq
    val cookies: Seq[Cookie] = response.select("cookies").asOpt[Seq[JsObject]].map { arr =>
      arr.map { c =>
        Cookie(
          name = c.select("name").asString,
          value = c.select("value").asString,
          maxAge = c.select("maxAge").asOpt[Int],
          path = c.select("path").asString,
          domain = c.select("domain").asOpt[String],
          secure = c.select("secure").asOpt[Boolean].getOrElse(false),
          httpOnly = c.select("httpOnly").asOpt[Boolean].getOrElse(false),
          sameSite = None,
        )
      }
    }.getOrElse(Seq.empty)
    val body = response.select("body").asOpt[String].map(b => ByteString(b).decodeBase64) match {
      case None => Source.empty[ByteString]
      case Some(b) => Source.single(b)
    }
    val contentType = headers.getIgnoreCase("Content-Type")
    val contentLength = headers.getIgnoreCase("Content-Length").map(_.toLong)
    Results.Status(status)
      .sendEntity(HttpEntity.Streamed(
        data = body,
        contentType = contentType,
        contentLength = contentLength,
      ))
      .withHeaders(headersList: _*)
      .withCookies(cookies: _*)
  }
}

class TunnelActor(out: ActorRef, tunnelId: String, req: RequestHeader, reversePingPong: Boolean, env: Env) extends Actor {

  private val logger = Logger(s"otoroshi-tunnel-actor")
  private val counter = new AtomicLong(0L)
  private val awaitingResponse = new scala.collection.concurrent.TrieMap[Long, Promise[Result]]()

  private def closeTunnel(): Unit = {
    awaitingResponse.values.map(p => p.trySuccess(Results.InternalServerError(Json.obj("error" -> "tunnel closed !"))))
    awaitingResponse.clear()
    env.tunnelManager.closeTunnel(tunnelId)
  }

  override def preStart(): Unit = {
    if (reversePingPong) {
      env.otoroshiScheduler.scheduleWithFixedDelay(10.seconds, 10.seconds)(new Runnable {
        override def run(): Unit = {
          out ! BinaryMessage(Json.obj("tunnel_id" -> tunnelId, "type" -> "pong").stringify.byteString)
        }
      })(env.otoroshiExecutionContext)
    }
  }

  override def postStop() = {
    closeTunnel()
  }

  def sendRequest(request: NgPluginHttpRequest, addr: String, secured: Boolean): Future[Result] = {
    val requestId: Long = counter.incrementAndGet()
    logger.debug(s"sending request to remote location through tunnel '${tunnelId}' - ${requestId}")
    val requestJson = TunnelActor.requestToJson(request, addr, secured, requestId).stringify.byteString
    val promise = Promise.apply[Result]()
    awaitingResponse.put(requestId, promise)
    out ! BinaryMessage(requestJson)
    promise.future
  }

  def sendRequestRaw(request: JsValue): Future[Result] = {
    val requestId: Long = counter.incrementAndGet()
    logger.debug(s"sending request to remote location through tunnel '${tunnelId}' - ${requestId}")
    val requestJson = (request.asObject ++ Json.obj("request_id" -> requestId)).stringify.byteString
    val promise = Promise.apply[Result]()
    awaitingResponse.put(requestId, promise)
    out ! BinaryMessage(requestJson)
    promise.future
  }

  private def handleResponse(data: ByteString): Unit = {
    val response = Json.parse(data.toArray)
    response.select("type").asString match {
      case "ping" => {
        logger.debug(s"ping message from client: ${data.utf8String}")
        env.tunnelManager.tunnelHeartBeat(tunnelId)
        if (!reversePingPong) {
          out ! BinaryMessage(Json.obj("tunnel_id" -> tunnelId, "type" -> "pong").stringify.byteString)
        }
      }
      case "pong" => {
        logger.debug(s"pong message from client: ${data.utf8String}")
        env.tunnelManager.tunnelHeartBeat(tunnelId)
        out ! BinaryMessage(Json.obj("tunnel_id" -> tunnelId, "type" -> "ping").stringify.byteString)
      }
      case "response" => Try {
        env.tunnelManager.tunnelHeartBeat(tunnelId)
        val requestId: Long = response.select("request_id").asLong
        logger.debug(s"got response on tunnel '${tunnelId}' - ${requestId}")
        val result = TunnelActor.responseToResult(response)
        awaitingResponse.get(requestId).foreach { tunnel =>
          logger.debug(s"found the promise for ${requestId}")
          tunnel.trySuccess(result)
          awaitingResponse.remove(requestId)
          ()
        }
      } match {
        case Failure(exception) => exception.printStackTrace()
        case Success(value) => ()
      }
    }
  }

  def receive = {
    case TextMessage(text)   =>
      logger.warn(s"invalid message, '${text}'")
    case BinaryMessage(data) =>
      handleResponse(data)
    case CloseMessage(status, reason) =>
      logger.info(s"closing tunnel ${tunnelId} - ${status} - ${reason}")
      closeTunnel()
      self ! PoisonPill
    case PingMessage(data) =>
      logger.debug(s"mping message from client: ${data.utf8String}")
      env.tunnelManager.tunnelHeartBeat(tunnelId)
      out ! PongMessage(Json.obj("tunnel_id" -> tunnelId).stringify.byteString)
    case PongMessage(data) =>
      logger.debug(s"mpong message from client: ${data.utf8String}")
      env.tunnelManager.tunnelHeartBeat(tunnelId)
      out ! PingMessage(Json.obj("tunnel_id" -> tunnelId).stringify.byteString)
  }
}