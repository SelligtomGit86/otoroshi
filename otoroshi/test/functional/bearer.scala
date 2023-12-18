package functional

import com.typesafe.config.ConfigFactory
import functional.Implicits.BetterFuture
import play.api.Configuration
import play.api.libs.json.JsObject

class ApikeyBearerSpec extends OtoroshiSpec {

  s"#1795" should {
    "warm up" in {
      startOtoroshi()
    }
    "work" in {
      val apikey = otoroshiComponents.env.proxyState.apikey(otoroshiComponents.env.backOfficeApiKeyClientId).get
      val bearer = apikey.toBearer(otoroshiComponents.env)
      for (i <- 0 to 100) {
        println(apikey.toBearer(otoroshiComponents.env))
      }
      val (body, status) = wsClient
        .url(s"http://127.0.0.1:${port}/apis/apim.otoroshi.io/v1/apikeys")
        .withHttpHeaders(
          "Host" -> "otoroshi-api.oto.tools",
          "Accept" -> "application/json",
          "Authorization" -> s"Bearer ${bearer}"
        )
        .withFollowRedirects(false)
        .get()
        .map { response =>
          (response.json, response.status)
        }
        .await()
      status mustBe 200
      body.as[Seq[JsObject]].size mustBe 2
    }
    "shutdown" in {
      stopAll()
    }
  }

  override def getTestConfiguration(configuration: Configuration) = {
    Configuration(
      ConfigFactory.parseString(s"""app.env = dev""".stripMargin).resolve()
    ).withFallback(configuration)
  }
}
