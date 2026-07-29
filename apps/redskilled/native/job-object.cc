/*
 * job-object — the native reach the Windows placement backend is built on.
 *
 * Node reaches no part of the Job Object API on its own, and #2780 decided the
 * mechanism: an N-API addon loaded in-process, not a helper binary. This is that
 * addon, and it is deliberately the smallest surface that can carry the
 * decision — create a job with limits, put a process inside it, close it.
 *
 * **Written against the C Node-API, with no dependency.** Node-API's ABI is
 * stable across Node majors, so an artifact built once keeps loading; using the
 * C headers rather than `node-addon-api` keeps the build free of a node_modules
 * dependency, which is what lets a prebuild be a single file with nothing behind
 * it.
 *
 * **Kill-on-close is not a parameter.** It is set on every job this addon
 * creates, because it is the property that makes a Worker unable to outlive the
 * job that owns it. The consequence is explicit: the handle's lifetime IS the
 * Worker's lifetime, so the daemon holds it for the Worker's life and closing it
 * (or dropping it) ends the Worker.
 *
 * Every failure is thrown with the Win32 error code that caused it. A caller
 * that could only see "it did not work" would degrade to the sampling floor
 * without being able to say why, which is the silent downgrade the whole backend
 * is shaped to avoid.
 */
#include <node_api.h>

#include <windows.h>

#include <string>
#include <vector>

namespace {

struct JobObjectHolder {
  HANDLE handle;
};

void ThrowWin32(napi_env env, const char* what, DWORD code) {
  std::string message = std::string(what) + " failed with Win32 error " + std::to_string(code);
  napi_throw_error(env, nullptr, message.c_str());
}

bool ReadOptionalNumber(napi_env env, napi_value object, const char* key, double* out) {
  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return false;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return false;
  if (type != napi_number) return false;
  return napi_get_value_double(env, value, out) == napi_ok;
}

/** Read a JS string as UTF-16, which is what every `W` entry point wants. */
bool ReadUtf16(napi_env env, napi_value value, std::wstring* out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char16_t> buffer(length + 1, 0);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  out->assign(reinterpret_cast<const wchar_t*>(buffer.data()), length);
  return true;
}

JobObjectHolder* Unwrap(napi_env env, napi_callback_info info, napi_value* argv, size_t* argc) {
  napi_value self;
  void* data = nullptr;
  if (napi_get_cb_info(env, info, argc, argv, &self, nullptr) != napi_ok) return nullptr;
  if (napi_unwrap(env, self, &data) != napi_ok) return nullptr;
  return static_cast<JobObjectHolder*>(data);
}

/** `assign(pid)` — put a LIVE process under this job's limits. */
napi_value Assign(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  JobObjectHolder* holder = Unwrap(env, info, argv, &argc);
  if (holder == nullptr || holder->handle == nullptr) {
    napi_throw_error(env, nullptr, "this Job Object is already closed, so nothing can be assigned to it");
    return nullptr;
  }
  int32_t pid = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_error(env, nullptr, "assign(pid) needs a positive process id");
    return nullptr;
  }

  // PROCESS_TERMINATE is asked for alongside PROCESS_SET_QUOTA so the job can
  // enforce, rather than merely observe, the limits it carries.
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
  if (process == nullptr) {
    ThrowWin32(env, "OpenProcess", GetLastError());
    return nullptr;
  }
  BOOL assigned = AssignProcessToJobObject(holder->handle, process);
  DWORD code = GetLastError();
  CloseHandle(process);
  if (!assigned) {
    ThrowWin32(env, "AssignProcessToJobObject", code);
    return nullptr;
  }
  return nullptr;
}

/** `close()` — release the job. With kill-on-close set, this ends what is inside. */
napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  JobObjectHolder* holder = Unwrap(env, info, nullptr, &argc);
  if (holder != nullptr && holder->handle != nullptr) {
    CloseHandle(holder->handle);
    holder->handle = nullptr;
  }
  return nullptr;
}

void FinalizeJob(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  JobObjectHolder* holder = static_cast<JobObjectHolder*>(data);
  if (holder == nullptr) return;
  // Collection closes the handle, which kills the Worker: the handle's lifetime
  // is the Worker's lifetime, and the daemon is what holds it.
  if (holder->handle != nullptr) CloseHandle(holder->handle);
  delete holder;
}

/** `createJobObject({ name, limits })` — a job carrying the budget, kill-on-close set. */
napi_value CreateJobObject(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "createJobObject({ name, limits }) needs its request object");
    return nullptr;
  }

  napi_value name_value;
  std::wstring name;
  if (napi_get_named_property(env, argv[0], "name", &name_value) != napi_ok || !ReadUtf16(env, name_value, &name)) {
    napi_throw_error(env, nullptr, "createJobObject needs a string name");
    return nullptr;
  }
  napi_value limits;
  if (napi_get_named_property(env, argv[0], "limits", &limits) != napi_ok) {
    napi_throw_error(env, nullptr, "createJobObject needs a limits object");
    return nullptr;
  }

  HANDLE job = CreateJobObjectW(nullptr, name.c_str());
  if (job == nullptr) {
    ThrowWin32(env, "CreateJobObjectW", GetLastError());
    return nullptr;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION extended = {};
  extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  double memory_bytes = 0;
  if (ReadOptionalNumber(env, limits, "memory_limit_bytes", &memory_bytes) && memory_bytes > 0) {
    extended.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    extended.JobMemoryLimit = static_cast<SIZE_T>(memory_bytes);
  }
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &extended, sizeof(extended))) {
    DWORD code = GetLastError();
    CloseHandle(job);
    ThrowWin32(env, "SetInformationJobObject(ExtendedLimitInformation)", code);
    return nullptr;
  }

  double cpu_rate_percent = 0;
  if (ReadOptionalNumber(env, limits, "cpu_rate_percent", &cpu_rate_percent) && cpu_rate_percent > 0) {
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu = {};
    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
    // The field is in hundredths of a percent.
    cpu.CpuRate = static_cast<DWORD>(cpu_rate_percent * 100);
    if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu))) {
      DWORD code = GetLastError();
      CloseHandle(job);
      ThrowWin32(env, "SetInformationJobObject(CpuRateControlInformation)", code);
      return nullptr;
    }
  }

  napi_value handle;
  if (napi_create_object(env, &handle) != napi_ok) {
    CloseHandle(job);
    napi_throw_error(env, nullptr, "could not build the Job Object handle object");
    return nullptr;
  }
  napi_set_named_property(env, handle, "name", name_value);

  napi_value assign_fn;
  napi_value close_fn;
  napi_create_function(env, "assign", NAPI_AUTO_LENGTH, Assign, nullptr, &assign_fn);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, nullptr, &close_fn);
  napi_set_named_property(env, handle, "assign", assign_fn);
  napi_set_named_property(env, handle, "close", close_fn);

  JobObjectHolder* holder = new JobObjectHolder{job};
  if (napi_wrap(env, handle, holder, FinalizeJob, nullptr, nullptr) != napi_ok) {
    CloseHandle(job);
    delete holder;
    napi_throw_error(env, nullptr, "could not attach the Job Object to its handle");
    return nullptr;
  }
  return handle;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value create_fn;
  napi_create_function(env, "createJobObject", NAPI_AUTO_LENGTH, CreateJobObject, nullptr, &create_fn);
  napi_set_named_property(env, exports, "createJobObject", create_fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
