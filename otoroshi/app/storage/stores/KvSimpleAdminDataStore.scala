package otoroshi.storage.stores

import akka.http.scaladsl.util.FastFuture
import env.Env
import models.SimpleAdminDataStore
import play.api.libs.json._
import utils.JsonImplicits._

import scala.util.Success
import akka.util.ByteString
import otoroshi.storage.RedisLike
import org.joda.time.DateTime
import play.api.Logger

import scala.concurrent.{ExecutionContext, Future}

class KvSimpleAdminDataStore(redisCli: RedisLike, _env: Env) extends SimpleAdminDataStore {

  lazy val logger = Logger("otoroshi-simple-admin-datastore")

  def key(id: String): String = s"${_env.storageRoot}:admins:$id"

  override def findByUsername(username: String)(implicit ec: ExecutionContext, env: Env): Future[Option[JsValue]] =
    redisCli.get(key(username)).map(_.map(v => Json.parse(v.utf8String)).map { user =>
      (user \ "metadata").asOpt[Map[String, String]] match {
        case None => user.as[JsObject] ++ Json.obj("metadata" -> Json.obj())
        case Some(_) => user
      }
    })

  override def findAll()(implicit ec: ExecutionContext, env: Env): Future[Seq[JsValue]] =
    redisCli
      .keys(key("*"))
      .flatMap(
        keys =>
          if (keys.isEmpty) FastFuture.successful(Seq.empty[Option[ByteString]])
          else redisCli.mget(keys: _*)
      )
      .map(seq => seq.filter(_.isDefined).map(_.get).map(v => Json.parse(v.utf8String)).map { user =>
        (user \ "metadata").asOpt[Map[String, String]] match {
          case None => user.as[JsObject] ++ Json.obj("metadata" -> Json.obj())
          case Some(_) => user
        }
      })

  override def deleteUser(username: String)(implicit ec: ExecutionContext, env: Env): Future[Long] =
    redisCli.del(key(username))

  def deleteUsers(usernames: Seq[String])(implicit ec: ExecutionContext, env: Env): Future[Long] = {
    redisCli.del(usernames.map(v => key(v)): _*)
  }

  override def registerUser(username: String, password: String, label: String, authorizedGroup: Option[String], metadata: Map[String, String] = Map.empty)(
      implicit ec: ExecutionContext,
      env: Env
  ): Future[Boolean] = {
    val group: JsValue = authorizedGroup match {
      case Some(g) => JsString(g)
      case None    => JsNull
    }
    redisCli.set(
      key(username),
      Json.stringify(
        Json.obj(
          "username"        -> username,
          "password"        -> password,
          "label"           -> label,
          "authorizedGroup" -> group,
          "createdAt"       -> DateTime.now(),
          "type"            -> "SIMPLE",
          "metadata"        -> metadata
        )
      )
    )
  }

  override def registerUser(user: JsValue)(
    implicit ec: ExecutionContext,
    env: Env
  ): Future[Boolean] = {
    redisCli.set(
      key((user \ "username").as[String]),
      Json.stringify(
        Json.obj(
          "username" -> (user \ "username").as[String],
          "password"        -> (user \ "password").as[String],
          "label"           -> (user \ "label").as[String],
          "authorizedGroup" -> JsNull,
          "createdAt"       -> (user \ "createdAt").as[Long],
          "type"            -> "SIMPLE",
          "metadata"        -> (user \ "metadata").as[Map[String, String]]
        )
      )
    )
  }

  override def hasAlreadyLoggedIn(username: String)(implicit ec: ExecutionContext, env: Env): Future[Boolean] =
    redisCli.sismember(s"${env.storageRoot}:users:alreadyloggedin", username)

  override def alreadyLoggedIn(email: String)(implicit ec: ExecutionContext, env: Env): Future[Long] =
    redisCli.sadd(s"${env.storageRoot}:users:alreadyloggedin", email)
}
