/*
 * The game-profile probe: run as a game would be (ProcessSandbox.spawnGame, under the headless or
 * windowed Seatbelt game profile) by tests/conformance/game-sandbox-profile.test.ts and
 * sandbox.test.ts, built at test time with `xcrun clang`. It reads one command per line from the
 * protocol pipe (the fd GENEX_STUDIO_FD names) and answers each with one JSON line on the same fd,
 * so a row asks exactly the question it proves. It starts nothing and opens no window.
 *
 *   echo <text>    {"echo":"<text>"}                 the pipe works both ways
 *   env            {"env":["NAME=value",...]}        the environment it was given
 *   self           {"pid":n,"pgid":n,"stdin":"..."}  its process group and what stdin is
 *   read <path>    {"read":errno}                    0 when the file opened for reading
 *   write <path>   {"write":errno}                   0 when the file opened for writing
 *   udp            {"udp":errno}                     connect() of a UDP socket to TEST-NET-1
 *   tcp <port>     {"tcp":errno}                     connect() of a TCP socket to 127.0.0.1:<port>
 *   fork           {"fork":errno}                    0 when fork() made a child
 *   setsid         {"setsid":errno}                  0 when setsid() succeeded
 *   setpgid        {"setpgid":errno}                 0 when setpgid(0, 0) succeeded
 *   metal          {"device":b,"msl":b}              a Metal device, and a tiny MSL compile on it
 *   metalpipe      {"pipeline":b,"ms":n}             an MSL compile and a compute pipeline made from it,
 *                                                    timed (a warm Metal shader cache makes it faster)
 *   cgl            {"cgl":b}                         an Apple OpenGL context compiled a shader
 *   lookup <name>  {"lookup":kern_return}            bootstrap_look_up of a Mach service
 *   hid            {"hid":IOReturn,"devices":n}      IOHIDManagerOpen matching gamepads only
 *   exit <code>    exits with <code>
 * End of input exits 0.
 */
#define GL_SILENCE_DEPRECATION 1
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDKeys.h>
#include <IOKit/hid/IOHIDManager.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <netinet/in.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
/* Metal's C entry point; the rest of Metal is reached through the Objective-C runtime. */
extern id MTLCreateSystemDefaultDevice(void);
extern void *objc_autoreleasePoolPush(void);
extern void objc_autoreleasePoolPop(void *pool);

#define LINE_MAX_BYTES 4096

static int pipe_fd = 3;

static void reply(const char *json) {
  size_t length = strlen(json);
  while (length > 0) {
    ssize_t wrote = write(pipe_fd, json, length);
    if (wrote <= 0) return;
    json += wrote;
    length -= (size_t)wrote;
  }
  (void)write(pipe_fd, "\n", 1);
}

/* `text` as a JSON string body: quotes, backslashes and control characters escaped. */
static void escaped(const char *text, char *out, size_t size) {
  size_t at = 0;
  for (const unsigned char *c = (const unsigned char *)text; *c && at + 7 < size; c++) {
    if (*c == '"' || *c == '\\') {
      out[at++] = '\\';
      out[at++] = (char)*c;
    } else if (*c < 0x20) {
      at += (size_t)snprintf(out + at, size - at, "\\u%04x", *c);
    } else {
      out[at++] = (char)*c;
    }
  }
  out[at] = '\0';
}

static void reply_errno(const char *key, int error) {
  char json[128];
  snprintf(json, sizeof json, "{\"%s\":%d}", key, error);
  reply(json);
}

static void probe_env(void) {
  char json[16384] = "{\"env\":[";
  size_t at = strlen(json);
  for (char **entry = environ; *entry; entry++) {
    char value[2048];
    escaped(*entry, value, sizeof value);
    at += (size_t)snprintf(json + at, sizeof json - at, "%s\"%s\"", entry == environ ? "" : ",", value);
    if (at >= sizeof json - 4) break;
  }
  snprintf(json + at, sizeof json - at, "]}");
  reply(json);
}

static void probe_self(void) {
  struct stat info;
  const char *stdin_kind = fstat(0, &info) != 0 ? "closed" : S_ISCHR(info.st_mode) ? "char-device" : "other";
  char json[256];
  snprintf(json, sizeof json, "{\"pid\":%d,\"pgid\":%d,\"stdin\":\"%s\"}", getpid(), getpgrp(), stdin_kind);
  reply(json);
}

static void probe_open(const char *key, const char *file, int flags) {
  int fd = open(file, flags, 0644);
  int error = fd < 0 ? errno : 0;
  if (fd >= 0) close(fd);
  reply_errno(key, error);
}

static void probe_udp(void) {
  int sock = socket(AF_INET, SOCK_DGRAM, 0);
  if (sock < 0) {
    reply_errno("udp", errno);
    return;
  }
  struct sockaddr_in to = {.sin_len = sizeof to, .sin_family = AF_INET, .sin_port = htons(9)};
  inet_pton(AF_INET, "192.0.2.1", &to.sin_addr); /* TEST-NET-1: a UDP connect sends nothing. */
  int error = connect(sock, (struct sockaddr *)&to, sizeof to) == 0 ? 0 : errno;
  close(sock);
  reply_errno("udp", error);
}

/* A device bridge on loopback (adb's 5037, an emulator's 5554...): 0 only when it connected. */
static void probe_tcp(const char *port) {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  if (sock < 0) {
    reply_errno("tcp", errno);
    return;
  }
  struct sockaddr_in to = {.sin_len = sizeof to, .sin_family = AF_INET, .sin_port = htons((uint16_t)atoi(port))};
  inet_pton(AF_INET, "127.0.0.1", &to.sin_addr);
  int error = connect(sock, (struct sockaddr *)&to, sizeof to) == 0 ? 0 : errno;
  close(sock);
  reply_errno("tcp", error);
}

static void probe_fork(void) {
  pid_t child = fork();
  if (child == 0) _exit(0);
  if (child < 0) {
    reply_errno("fork", errno);
    return;
  }
  int status = 0;
  waitpid(child, &status, 0);
  reply_errno("fork", 0);
}

static void probe_setsid(void) {
  reply_errno("setsid", setsid() < 0 ? errno : 0);
}

static void probe_setpgid(void) {
  reply_errno("setpgid", setpgid(0, 0) < 0 ? errno : 0);
}

static const char *const MSL =
    "#include <metal_stdlib>\nusing namespace metal;\n"
    "kernel void fill(device float *out [[buffer(0)]], uint i [[thread_position_in_grid]]) { out[i] = 1.0; }\n";

static void probe_metal(void) {
  void *pool = objc_autoreleasePoolPush();
  id device = MTLCreateSystemDefaultDevice();
  int compiled = 0;
  if (device) {
    id source = ((id (*)(Class, SEL, const char *))objc_msgSend)(objc_getClass("NSString"),
                                                                 sel_registerName("stringWithUTF8String:"), MSL);
    id error = NULL;
    id library = ((id (*)(id, SEL, id, id, id *))objc_msgSend)(
        device, sel_registerName("newLibraryWithSource:options:error:"), source, NULL, &error);
    compiled = library != NULL;
  }
  char json[64];
  snprintf(json, sizeof json, "{\"device\":%s,\"msl\":%s}", device ? "true" : "false", compiled ? "true" : "false");
  objc_autoreleasePoolPop(pool);
  reply(json);
}

/* A kernel heavy enough that its pipeline compile is measurable (tens of milliseconds cold). */
static const char *const PIPELINE_MSL =
    "#include <metal_stdlib>\nusing namespace metal;\n"
    "static float4 step4(float4 v, float k) { return fma(sin(v * k), cos(v.yzwx + k), sqrt(abs(v.wxyz) + k)); }\n"
    "kernel void heavy(device float4 *out [[buffer(0)]], uint i [[thread_position_in_grid]]) {\n"
    "  float4 v = float4(float(i), 1.0, 2.0, 3.0);\n"
    "  for (int a = 0; a < 6; a++) { v = step4(v, 0.5 + float(a));\n"
    "    if (v.x > v.y) { v = step4(v.yzwx, 1.5); } else { v = step4(v.zwxy, 2.5); }\n"
    "    v = step4(v, 3.0) * step4(v.wzyx, 4.0) + step4(v.xxyy, 5.0); }\n"
    "  out[i] = v; }\n";

static double now_ms(void) {
  struct timespec at;
  clock_gettime(CLOCK_MONOTONIC, &at);
  return (double)at.tv_sec * 1000.0 + (double)at.tv_nsec / 1e6;
}

static void probe_metal_pipeline(void) {
  void *pool = objc_autoreleasePoolPush();
  double start = now_ms();
  id device = MTLCreateSystemDefaultDevice();
  id pipeline = NULL;
  if (device) {
    id source = ((id (*)(Class, SEL, const char *))objc_msgSend)(objc_getClass("NSString"),
                                                                 sel_registerName("stringWithUTF8String:"), PIPELINE_MSL);
    id name = ((id (*)(Class, SEL, const char *))objc_msgSend)(objc_getClass("NSString"),
                                                               sel_registerName("stringWithUTF8String:"), "heavy");
    id error = NULL;
    id library = ((id (*)(id, SEL, id, id, id *))objc_msgSend)(
        device, sel_registerName("newLibraryWithSource:options:error:"), source, NULL, &error);
    id function = library ? ((id (*)(id, SEL, id))objc_msgSend)(library, sel_registerName("newFunctionWithName:"), name) : NULL;
    if (function)
      pipeline = ((id (*)(id, SEL, id, id *))objc_msgSend)(
          device, sel_registerName("newComputePipelineStateWithFunction:error:"), function, &error);
  }
  char json[96];
  snprintf(json, sizeof json, "{\"pipeline\":%s,\"ms\":%.1f}", pipeline ? "true" : "false", now_ms() - start);
  objc_autoreleasePoolPop(pool);
  reply(json);
}

typedef CGLError (*ChoosePixelFormat)(const CGLPixelFormatAttribute *, CGLPixelFormatObj *, GLint *);
typedef CGLError (*CreateContext)(CGLPixelFormatObj, CGLContextObj, CGLContextObj *);
typedef CGLError (*SetCurrentContext)(CGLContextObj);
typedef GLuint (*CreateShader)(GLenum);
typedef void (*ShaderSource)(GLuint, GLsizei, const GLchar *const *, const GLint *);
typedef void (*CompileShader)(GLuint);
typedef void (*GetShaderiv)(GLuint, GLenum, GLint *);

/* Apple OpenGL, reached the way a game could at run time: dlopen, never a link-time import. */
static int cgl_compiles(void) {
  void *gl = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_NOW);
  if (!gl) return 0;
  ChoosePixelFormat choose = (ChoosePixelFormat)dlsym(gl, "CGLChoosePixelFormat");
  CreateContext create = (CreateContext)dlsym(gl, "CGLCreateContext");
  SetCurrentContext set_current = (SetCurrentContext)dlsym(gl, "CGLSetCurrentContext");
  CreateShader create_shader = (CreateShader)dlsym(gl, "glCreateShader");
  ShaderSource shader_source = (ShaderSource)dlsym(gl, "glShaderSource");
  CompileShader compile_shader = (CompileShader)dlsym(gl, "glCompileShader");
  GetShaderiv get_shader = (GetShaderiv)dlsym(gl, "glGetShaderiv");
  if (!choose || !create || !set_current || !create_shader || !shader_source || !compile_shader || !get_shader) return 0;
  CGLPixelFormatAttribute attributes[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
                                          kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0};
  CGLPixelFormatObj format = NULL;
  GLint formats = 0;
  CGLContextObj context = NULL;
  if (choose(attributes, &format, &formats) != kCGLNoError || !format) return 0;
  if (create(format, NULL, &context) != kCGLNoError || !context) return 0;
  set_current(context);
  const char *text = "#version 330 core\nvoid main() { gl_Position = vec4(0.0); }\n";
  GLuint shader = create_shader(GL_VERTEX_SHADER);
  shader_source(shader, 1, &text, NULL);
  compile_shader(shader);
  GLint compiled = 0;
  get_shader(shader, GL_COMPILE_STATUS, &compiled);
  set_current(NULL);
  return compiled != 0;
}

static void probe_cgl(void) {
  reply(cgl_compiles() ? "{\"cgl\":true}" : "{\"cgl\":false}");
}

static void probe_lookup(const char *name) {
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t result = bootstrap_look_up(bootstrap_port, name, &port);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  reply_errno("lookup", result);
}

/* Gamepads and joysticks only: never a keyboard, which is what Input Monitoring guards. */
static void probe_hid(void) {
  IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  int page = 0x01, usage = 0x05;
  CFNumberRef page_number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usage_number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  const void *keys[] = {CFSTR(kIOHIDDeviceUsagePageKey), CFSTR(kIOHIDDeviceUsageKey)};
  const void *values[] = {page_number, usage_number};
  CFDictionaryRef matching = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks,
                                                &kCFTypeDictionaryValueCallBacks);
  IOHIDManagerSetDeviceMatching(manager, matching);
  IOReturn opened = IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone);
  CFSetRef devices = IOHIDManagerCopyDevices(manager);
  long count = devices ? CFSetGetCount(devices) : 0;
  char json[96];
  snprintf(json, sizeof json, "{\"hid\":%d,\"devices\":%ld}", opened, count);
  if (devices) CFRelease(devices);
  IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
  CFRelease(matching);
  CFRelease(page_number);
  CFRelease(usage_number);
  CFRelease(manager);
  reply(json);
}

static void run(char *line) {
  char *arg = strchr(line, ' ');
  if (arg) *arg++ = '\0';
  const char *rest = arg ? arg : "";
  if (!strcmp(line, "echo")) {
    char text[LINE_MAX_BYTES * 2], json[LINE_MAX_BYTES * 2 + 16];
    escaped(rest, text, sizeof text);
    snprintf(json, sizeof json, "{\"echo\":\"%s\"}", text);
    reply(json);
  } else if (!strcmp(line, "env")) probe_env();
  else if (!strcmp(line, "self")) probe_self();
  else if (!strcmp(line, "read")) probe_open("read", rest, O_RDONLY);
  else if (!strcmp(line, "write")) probe_open("write", rest, O_WRONLY | O_CREAT | O_TRUNC);
  else if (!strcmp(line, "udp")) probe_udp();
  else if (!strcmp(line, "tcp")) probe_tcp(rest);
  else if (!strcmp(line, "fork")) probe_fork();
  else if (!strcmp(line, "setsid")) probe_setsid();
  else if (!strcmp(line, "setpgid")) probe_setpgid();
  else if (!strcmp(line, "metal")) probe_metal();
  else if (!strcmp(line, "metalpipe")) probe_metal_pipeline();
  else if (!strcmp(line, "cgl")) probe_cgl();
  else if (!strcmp(line, "lookup")) probe_lookup(rest);
  else if (!strcmp(line, "hid")) probe_hid();
  else if (!strcmp(line, "exit")) exit(atoi(rest));
  else reply("{\"unknown\":true}");
}

int main(void) {
  const char *fd_text = getenv("GENEX_STUDIO_FD");
  if (fd_text) pipe_fd = atoi(fd_text);
  (void)write(1, "probe stdout\n", 13);
  (void)write(2, "probe stderr\n", 13);
  char buffer[LINE_MAX_BYTES];
  size_t held = 0;
  for (;;) {
    ssize_t got = read(pipe_fd, buffer + held, sizeof buffer - held - 1);
    if (got <= 0) return 0;
    held += (size_t)got;
    char *newline;
    while ((newline = memchr(buffer, '\n', held))) {
      *newline = '\0';
      run(buffer);
      size_t used = (size_t)(newline - buffer) + 1;
      memmove(buffer, buffer + used, held - used);
      held -= used;
    }
    if (held == sizeof buffer - 1) held = 0; /* an over-long line is dropped */
  }
}
