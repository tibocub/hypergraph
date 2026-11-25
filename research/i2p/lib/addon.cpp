// i2pd as a library: start(dataDir, samPort) / stop(). No daemon, no GUI code.
#include <node_api.h>
#include <string>
#include <vector>
#include "api.h"
#include "ClientContext.h"

static bool running = false;

static std::string str(napi_env env, napi_value v) {
  size_t n = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &n);
  std::string s(n, '\0');
  napi_get_value_string_utf8(env, v, &s[0], n + 1, &n);
  return s;
}

static napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (running || argc < 2) { napi_throw_error(env, nullptr, "start(dataDir, samPort): already running or bad args"); return nullptr; }
  int port = 0; napi_get_value_int32(env, argv[1], &port);
  static std::vector<std::string> a;
  a = {"i2pd", "--datadir=" + str(env, argv[0]), "--sam.enabled=true", "--sam.address=127.0.0.1",
       "--sam.port=" + std::to_string(port), "--http.enabled=false", "--httpproxy.enabled=false",
       "--socksproxy.enabled=false", "--i2pcontrol.enabled=false", "--upnp.enabled=false"};
  static std::vector<char*> p; p.clear();
  for (auto& s : a) p.push_back(&s[0]);
  i2p::api::InitI2P((int)p.size(), p.data(), "i2pd");
  i2p::api::StartI2P();
  i2p::client::context.Start();
  running = true;
  return nullptr;
}

static napi_value stop(napi_env env, napi_callback_info) {
  if (running) {
    i2p::client::context.Stop();
    i2p::api::StopI2P();
    i2p::api::TerminateI2P();
    running = false;
  }
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_value f;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, start, nullptr, &f);
  napi_set_named_property(env, exports, "start", f);
  napi_create_function(env, "stop", NAPI_AUTO_LENGTH, stop, nullptr, &f);
  napi_set_named_property(env, exports, "stop", f);
  return exports;
}
