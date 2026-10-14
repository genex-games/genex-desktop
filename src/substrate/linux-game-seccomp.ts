/**
 * The seccomp filter bubblewrap loads into a boxed Linux game (`--seccomp 4`, see
 * `linux-game-box.ts`): a classic BPF program over the kernel's `struct seccomp_data`, for the
 * x86-64 and AArch64 system-call ABIs. A call through any other ABI (32-bit compat, x32, a foreign
 * architecture) kills the game, because its numbers would mean other calls.
 *
 * Refused with EPERM: tracing and reading other processes, mounts and namespaces (`unshare`,
 * `setns`, `clone` with a `CLONE_NEW*` flag), kernel keyrings, module and kexec loading, BPF, perf
 * events, userfaultfd, io_uring (whose operations bypass seccomp), handle-based opens, clock and
 * system administration, `personality`, and terminal input injection (`TIOCSTI`, `TIOCLINUX`).
 * `clone3` answers ENOSYS, so the C library falls back to `clone`, whose flags a filter can read.
 * Sockets: a headless run may create none (its protocol pipe is inherited, not created); windowed
 * play may create only AF_UNIX sockets, for Wayland and audio. Every other family answers
 * EAFNOSUPPORT. Connected pairs (`socketpair`) reach nothing outside the game and stay allowed.
 *
 * Not covered: seccomp cannot see paths, so it does not stop the game from executing a file it
 * wrote to `/state` or `/tmp` (an open item for Landlock).
 */

/** Which sockets the game may create. */
export interface LinuxGameSeccompOptions {
  /** Windowed play: AF_UNIX for the Wayland and audio sockets. Headless: none. */
  unixSockets: boolean;
}

/** `struct sock_filter`: u16 code, u8 jt, u8 jf, u32 k, little-endian on both ABIs. */
const INSTRUCTION_BYTES = 8;

/** The classic BPF opcodes the filter uses. */
const BpfOp = {
  /** BPF_LD | BPF_W | BPF_ABS */
  LoadWord: 0x20,
  /** BPF_JMP | BPF_JA */
  Jump: 0x05,
  /** BPF_JMP | BPF_JEQ | BPF_K */
  JumpIfEqual: 0x15,
  /** BPF_JMP | BPF_JGE | BPF_K */
  JumpIfAtLeast: 0x35,
  /** BPF_JMP | BPF_JSET | BPF_K */
  JumpIfAnyBit: 0x45,
  /** BPF_RET | BPF_K */
  Return: 0x06,
} as const;
type BpfOp = (typeof BpfOp)[keyof typeof BpfOp];

/** Offsets in `struct seccomp_data`: the call number, the ABI, and each argument's low word. */
const NR_OFFSET = 0;
const ARCH_OFFSET = 4;
const ARGS_OFFSET = 16;
const ARG_BYTES = 8;

/** Seccomp's verdicts. */
const SeccompReturn = {
  KillProcess: 0x80000000,
  Errno: 0x00050000,
  Allow: 0x7fff0000,
} as const;

/** `AUDIT_ARCH_*` values the kernel reports in `seccomp_data.arch`. */
const AuditArch = { X86_64: 0xc000003e, Aarch64: 0xc00000b7 } as const;

/** The errors a refused call answers with. */
const Errno = { Perm: 1, NoSys: 38, AfNoSupport: 97 } as const;

const AF_UNIX = 1;
/** Every `CLONE_NEW*` flag: NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET. */
const CLONE_NEW_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;
/** Terminal ioctls that inject input or reach the console. */
const TIOCSTI = 0x5412;
const TIOCLINUX = 0x541c;
/** Calls at or above this number on x86-64 are the x32 ABI. */
const X32_SYSCALL_BIT = 0x40000000;

/** One ABI's call numbers. */
interface SyscallAbi {
  arch: number;
  /** The x32 marker bit, on x86-64 only. */
  x32Bit: number | null;
  socket: number;
  clone: number;
  clone3: number;
  ioctl: number;
  /** Refused with EPERM. */
  refused: readonly number[];
}

/**
 * Calls refused with EPERM: [x86-64, AArch64], null where the ABI has no such call
 * (arch/x86/entry/syscalls/syscall_64.tbl, include/uapi/asm-generic/unistd.h).
 */
const REFUSED_SYSCALLS = {
  ptrace: [101, 117],
  process_vm_readv: [310, 270],
  process_vm_writev: [311, 271],
  pidfd_getfd: [438, 438],
  kcmp: [312, 272],
  process_madvise: [440, 440],
  personality: [135, 92],
  mount: [165, 40],
  umount2: [166, 39],
  pivot_root: [155, 41],
  chroot: [161, 51],
  open_tree: [428, 428],
  move_mount: [429, 429],
  fsopen: [430, 430],
  fsconfig: [431, 431],
  fsmount: [432, 432],
  fspick: [433, 433],
  mount_setattr: [442, 442],
  unshare: [272, 97],
  setns: [308, 268],
  keyctl: [250, 219],
  add_key: [248, 217],
  request_key: [249, 218],
  init_module: [175, 105],
  finit_module: [313, 273],
  delete_module: [176, 106],
  kexec_load: [246, 104],
  kexec_file_load: [320, 294],
  bpf: [321, 280],
  perf_event_open: [298, 241],
  userfaultfd: [323, 282],
  io_uring_setup: [425, 425],
  io_uring_enter: [426, 426],
  io_uring_register: [427, 427],
  open_by_handle_at: [304, 265],
  name_to_handle_at: [303, 264],
  fanotify_init: [300, 262],
  lookup_dcookie: [212, 18],
  reboot: [169, 142],
  swapon: [167, 224],
  swapoff: [168, 225],
  acct: [163, 89],
  quotactl: [179, 60],
  quotactl_fd: [443, 443],
  syslog: [103, 116],
  settimeofday: [164, 170],
  clock_settime: [227, 112],
  adjtimex: [159, 171],
  clock_adjtime: [305, 266],
  vhangup: [153, 58],
  nfsservctl: [180, 42],
  uselib: [134, null],
  ioperm: [173, null],
  iopl: [172, null],
} as const satisfies Record<string, readonly [number, number | null]>;

function refusedOn(index: 0 | 1): number[] {
  const numbers: number[] = [];
  for (const pair of Object.values(REFUSED_SYSCALLS)) {
    const nr: number | null = pair[index];
    if (nr !== null) numbers.push(nr);
  }
  return numbers;
}

const X86_64: SyscallAbi = {
  arch: AuditArch.X86_64,
  x32Bit: X32_SYSCALL_BIT,
  socket: 41,
  clone: 56,
  clone3: 435,
  ioctl: 16,
  refused: refusedOn(0),
};

const AARCH64: SyscallAbi = {
  arch: AuditArch.Aarch64,
  x32Bit: null,
  socket: 198,
  clone: 220,
  clone3: 435,
  ioctl: 29,
  refused: refusedOn(1),
};

interface Instruction {
  code: BpfOp;
  jt: number;
  jf: number;
  k: number;
}

function statement(code: BpfOp, k: number): Instruction {
  return { code, jt: 0, jf: 0, k };
}

function branch(code: BpfOp, k: number, jt: number, jf: number): Instruction {
  return { code, jt, jf, k };
}

function verdict(value: number): Instruction {
  return statement(BpfOp.Return, value);
}

function errno(value: number): Instruction {
  return verdict(SeccompReturn.Errno | value);
}

function loadArg(index: number): Instruction {
  return statement(BpfOp.LoadWord, ARGS_OFFSET + index * ARG_BYTES);
}

/** `socket(family, …)`: AF_UNIX only when allowed, every other family EAFNOSUPPORT. */
function socketRule(unixSockets: boolean): Instruction[] {
  if (!unixSockets) return [errno(Errno.AfNoSupport)];
  return [loadArg(0), branch(BpfOp.JumpIfEqual, AF_UNIX, 0, 1), verdict(SeccompReturn.Allow), errno(Errno.AfNoSupport)];
}

/** `clone(flags, …)`: no new namespace of any kind. */
function cloneRule(): Instruction[] {
  return [
    loadArg(0),
    branch(BpfOp.JumpIfAnyBit, CLONE_NEW_FLAGS, 0, 1),
    errno(Errno.Perm),
    verdict(SeccompReturn.Allow),
  ];
}

/** `ioctl(fd, request, …)`: no terminal input injection. */
function ioctlRule(): Instruction[] {
  return [
    loadArg(1),
    branch(BpfOp.JumpIfEqual, TIOCSTI, 2, 0),
    branch(BpfOp.JumpIfEqual, TIOCLINUX, 1, 0),
    verdict(SeccompReturn.Allow),
    errno(Errno.Perm),
  ];
}

/** One ABI's rules: every path ends in a verdict, so blocks never run into each other. */
function abiBlock(abi: SyscallAbi, options: LinuxGameSeccompOptions): Instruction[] {
  const block = [statement(BpfOp.LoadWord, NR_OFFSET)];
  if (abi.x32Bit !== null) {
    block.push(branch(BpfOp.JumpIfAtLeast, abi.x32Bit, 0, 1), verdict(SeccompReturn.KillProcess));
  }
  for (const nr of abi.refused) block.push(branch(BpfOp.JumpIfEqual, nr, 0, 1), errno(Errno.Perm));
  block.push(branch(BpfOp.JumpIfEqual, abi.clone3, 0, 1), errno(Errno.NoSys));
  const ruled: [number, Instruction[]][] = [
    [abi.socket, socketRule(options.unixSockets)],
    [abi.clone, cloneRule()],
    [abi.ioctl, ioctlRule()],
  ];
  for (const [nr, rule] of ruled) block.push(branch(BpfOp.JumpIfEqual, nr, 0, rule.length), ...rule);
  block.push(verdict(SeccompReturn.Allow));
  return block;
}

function encode(instructions: readonly Instruction[]): Uint8Array {
  const program = Buffer.alloc(instructions.length * INSTRUCTION_BYTES);
  instructions.forEach((instruction, index) => {
    const at = index * INSTRUCTION_BYTES;
    program.writeUInt16LE(instruction.code, at);
    program.writeUInt8(instruction.jt, at + 2);
    program.writeUInt8(instruction.jf, at + 3);
    program.writeUInt32LE(instruction.k >>> 0, at + 4);
  });
  return program;
}

/** The compiled filter, as bubblewrap's `--seccomp` reads it from a file descriptor. */
export function linuxGameSeccompProgram(options: LinuxGameSeccompOptions): Uint8Array {
  const x86 = abiBlock(X86_64, options);
  const arm = abiBlock(AARCH64, options);
  // 0 load arch; 1 AArch64? → 2 : 3; 2 jump to the AArch64 block; 3 x86-64? → 5 : 4; 4 kill.
  const head = [
    statement(BpfOp.LoadWord, ARCH_OFFSET),
    branch(BpfOp.JumpIfEqual, AuditArch.Aarch64, 0, 1),
    statement(BpfOp.Jump, x86.length + 2),
    branch(BpfOp.JumpIfEqual, AuditArch.X86_64, 1, 0),
    verdict(SeccompReturn.KillProcess),
  ];
  return encode([...head, ...x86, ...arm]);
}
