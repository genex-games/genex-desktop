/**
 * The seccomp filter bubblewrap loads into a boxed Linux game (M7). The program is run here through
 * a small classic-BPF interpreter over `struct seccomp_data`, with syscall numbers taken from the
 * kernel's x86-64 and AArch64 tables (written out below, not read from the module), so each row
 * asserts what the kernel would decide for one call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linuxGameSeccompProgram } from "../../src/substrate/linux-game-seccomp.ts";

const RET_KILL_PROCESS = 0x80000000;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;
const EAFNOSUPPORT = 97;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const AUDIT_ARCH_I386 = 0x40000003;
const AUDIT_ARCH_ARM = 0x40000028;
const AUDIT_ARCH_RISCV64 = 0xc00000f3;
const X32_SYSCALL_BIT = 0x40000000;
const MAX_INSTRUCTIONS = 4096;

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const AF_PACKET = 17;
const SIGCHLD = 17;
/** What glibc's pthread_create passes to clone. */
const THREAD_FLAGS = 0x3d0f00;
const CLONE_NEWNS = 0x00020000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWNET = 0x40000000;
const TIOCSTI = 0x5412;
const TIOCLINUX = 0x541c;
const FIONREAD = 0x541b;
/** DRM_IOCTL_VERSION, as Mesa sends it to a render node. */
const DRM_IOCTL_VERSION = 0xc0406400;

/** The kernel's syscall numbers on each ABI (arch/x86/entry/syscalls, include/uapi/asm-generic/unistd.h). */
const NR = {
  x86: {
    read: 0,
    write: 1,
    mmap: 9,
    ioctl: 16,
    socket: 41,
    socketpair: 53,
    clone: 56,
    execve: 59,
    ptrace: 101,
    personality: 135,
    mount: 165,
    init_module: 175,
    futex: 202,
    kexec_load: 246,
    keyctl: 250,
    openat: 257,
    unshare: 272,
    perf_event_open: 298,
    open_by_handle_at: 304,
    setns: 308,
    process_vm_readv: 310,
    bpf: 321,
    userfaultfd: 323,
    io_uring_setup: 425,
    fsopen: 430,
    clone3: 435,
  },
  arm: {
    read: 63,
    write: 64,
    mmap: 222,
    ioctl: 29,
    socket: 198,
    socketpair: 199,
    clone: 220,
    execve: 221,
    ptrace: 117,
    personality: 92,
    mount: 40,
    init_module: 105,
    futex: 98,
    kexec_load: 104,
    keyctl: 219,
    openat: 56,
    unshare: 97,
    perf_event_open: 241,
    open_by_handle_at: 265,
    setns: 268,
    process_vm_readv: 270,
    bpf: 280,
    userfaultfd: 282,
    io_uring_setup: 425,
    fsopen: 430,
    clone3: 435,
  },
} as const;
type Syscall = keyof typeof NR.x86;
const ARCHES = [
  { name: "x86-64", arch: AUDIT_ARCH_X86_64, nr: NR.x86 },
  { name: "aarch64", arch: AUDIT_ARCH_AARCH64, nr: NR.arm },
] as const;

interface Call {
  arch: number;
  nr: number;
  args?: readonly number[];
}

/** `struct seccomp_data` as the kernel lays it out: nr, arch, instruction pointer, six 64-bit args. */
function seccompData(call: Call): Buffer {
  const data = Buffer.alloc(64);
  data.writeInt32LE(call.nr | 0, 0);
  data.writeUInt32LE(call.arch, 4);
  (call.args ?? []).forEach((arg, index) => {
    data.writeBigUInt64LE(BigInt(arg), 16 + index * 8);
  });
  return data;
}

interface Instruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

function decode(program: Uint8Array): Instruction[] {
  assert.equal(program.length % 8, 0, "a whole number of sock_filter entries");
  const bytes = Buffer.from(program.buffer, program.byteOffset, program.byteLength);
  const out: Instruction[] = [];
  for (let at = 0; at < bytes.length; at += 8) {
    out.push({
      code: bytes.readUInt16LE(at),
      jt: bytes.readUInt8(at + 2),
      jf: bytes.readUInt8(at + 3),
      k: bytes.readUInt32LE(at + 4),
    });
  }
  return out;
}

/** Runs a classic BPF program the way the kernel's seccomp does, for the opcodes a filter uses. */
function run(program: Uint8Array, call: Call): number {
  const code = decode(program);
  const data = seccompData(call);
  let accumulator = 0;
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc] as Instruction;
    pc += 1;
    switch (op.code) {
      case 0x20: // BPF_LD | BPF_W | BPF_ABS
        assert.ok(op.k % 4 === 0 && op.k < 64, `load offset ${op.k}`);
        accumulator = data.readUInt32LE(op.k);
        break;
      case 0x05: // BPF_JMP | BPF_JA
        pc += op.k;
        break;
      case 0x15: // BPF_JEQ | BPF_K
        pc += accumulator === op.k ? op.jt : op.jf;
        break;
      case 0x35: // BPF_JGE | BPF_K
        pc += accumulator >= op.k ? op.jt : op.jf;
        break;
      case 0x45: // BPF_JSET | BPF_K
        pc += (accumulator & op.k) !== 0 ? op.jt : op.jf;
        break;
      case 0x06: // BPF_RET | BPF_K
        return op.k;
      default:
        assert.fail(`unexpected opcode 0x${op.code.toString(16)}`);
    }
  }
  return assert.fail("the program ran off its end");
}

const errno = (value: number) => RET_ERRNO | value;
const WINDOWED = linuxGameSeccompProgram({ unixSockets: true });
const HEADLESS = linuxGameSeccompProgram({ unixSockets: false });
const VARIANTS = [
  { name: "windowed", program: WINDOWED },
  { name: "headless", program: HEADLESS },
] as const;

describe("the Linux game seccomp filter: shape", () => {
  it("is a loadable classic BPF program whose every jump lands inside it", () => {
    for (const { name, program } of VARIANTS) {
      const code = decode(program);
      assert.ok(code.length > 0 && code.length <= MAX_INSTRUCTIONS, name);
      code.forEach((op, index) => {
        const isJump = (op.code & 0x07) === 0x05;
        if (!isJump) return;
        const targets = op.code === 0x05 ? [op.k] : [op.jt, op.jf];
        for (const offset of targets) assert.ok(index + 1 + offset < code.length, `${name}: jump at ${index}`);
      });
    }
  });
});

describe("the Linux game seccomp filter: verdicts", () => {
  it("lets ordinary calls through on both ABIs", () => {
    for (const { name, program } of VARIANTS) {
      for (const abi of ARCHES) {
        for (const call of ["read", "write", "mmap", "openat", "execve", "futex"] as const) {
          assert.equal(run(program, { arch: abi.arch, nr: abi.nr[call] }), RET_ALLOW, `${name} ${abi.name} ${call}`);
        }
      }
    }
  });

  it("refuses tracing, mounts, namespaces, keyrings, module loading, BPF, perf, userfaultfd and io_uring", () => {
    const refused: Syscall[] = [
      "ptrace",
      "process_vm_readv",
      "mount",
      "fsopen",
      "unshare",
      "setns",
      "keyctl",
      "init_module",
      "kexec_load",
      "bpf",
      "perf_event_open",
      "userfaultfd",
      "io_uring_setup",
      "open_by_handle_at",
      "personality",
    ];
    for (const { name, program } of VARIANTS) {
      for (const abi of ARCHES) {
        for (const call of refused) {
          assert.equal(run(program, { arch: abi.arch, nr: abi.nr[call] }), errno(EPERM), `${name} ${abi.name} ${call}`);
        }
      }
    }
  });

  it("answers clone3 with ENOSYS so the C library falls back to clone, whose flags it reads", () => {
    for (const { program } of VARIANTS) {
      for (const abi of ARCHES) {
        assert.equal(run(program, { arch: abi.arch, nr: abi.nr.clone3 }), errno(ENOSYS), abi.name);
        const clone = (flags: number) => run(program, { arch: abi.arch, nr: abi.nr.clone, args: [flags] });
        assert.equal(clone(SIGCHLD), RET_ALLOW, `${abi.name} fork`);
        assert.equal(clone(THREAD_FLAGS), RET_ALLOW, `${abi.name} thread`);
        for (const flag of [CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWNET]) {
          assert.equal(clone(SIGCHLD | flag), errno(EPERM), `${abi.name} 0x${flag.toString(16)}`);
        }
      }
    }
  });

  it("refuses terminal input injection and lets other ioctls through", () => {
    for (const { program } of VARIANTS) {
      for (const abi of ARCHES) {
        const ioctl = (request: number) => run(program, { arch: abi.arch, nr: abi.nr.ioctl, args: [0, request] });
        assert.equal(ioctl(TIOCSTI), errno(EPERM), abi.name);
        assert.equal(ioctl(TIOCLINUX), errno(EPERM), abi.name);
        assert.equal(ioctl(FIONREAD), RET_ALLOW, abi.name);
        assert.equal(ioctl(DRM_IOCTL_VERSION), RET_ALLOW, abi.name);
      }
    }
  });

  it("headless creates no socket at all; windowed creates only Unix sockets", () => {
    for (const abi of ARCHES) {
      const socket = (program: Uint8Array, family: number) =>
        run(program, { arch: abi.arch, nr: abi.nr.socket, args: [family, 1, 0] });
      assert.equal(socket(HEADLESS, AF_UNIX), errno(EAFNOSUPPORT), `${abi.name} headless unix`);
      assert.equal(socket(WINDOWED, AF_UNIX), RET_ALLOW, `${abi.name} windowed unix`);
      for (const family of [AF_INET, AF_INET6, AF_NETLINK, AF_PACKET]) {
        for (const { name, program } of VARIANTS) {
          assert.equal(socket(program, family), errno(EAFNOSUPPORT), `${name} ${abi.name} family ${family}`);
        }
      }
      // A connected pair reaches nothing outside the game.
      assert.equal(run(HEADLESS, { arch: abi.arch, nr: abi.nr.socketpair, args: [AF_UNIX, 1, 0] }), RET_ALLOW);
    }
  });

  it("kills a call made through any other ABI, x32 included", () => {
    for (const { name, program } of VARIANTS) {
      for (const arch of [AUDIT_ARCH_I386, AUDIT_ARCH_ARM, AUDIT_ARCH_RISCV64, 0]) {
        assert.equal(run(program, { arch, nr: 0 }), RET_KILL_PROCESS, `${name} arch 0x${arch.toString(16)}`);
      }
      const x32Read = run(program, { arch: AUDIT_ARCH_X86_64, nr: X32_SYSCALL_BIT | NR.x86.read });
      assert.equal(x32Read, RET_KILL_PROCESS, `${name} x32`);
    }
  });
});
