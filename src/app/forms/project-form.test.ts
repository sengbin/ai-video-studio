// ------------------------------------------------------------------------
// 名称：project-form.test.ts
// 说明：项目表单定义的自动化测试：字段描述、初始值、唯一性检查与提交。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { ProjectService } from '../services/project-service';
import { createEditProjectForm, createNewProjectForm, createProjectFormCatalog, PROJECT_FORM_NAMES } from './project-form';

/** 创建服务及其内存数据库。 */
function createService() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  return { database, service: new ProjectService(new SqliteProjectRepository(database)) };
}

test('新建表单：标题、字段与初始值', () => {
  const { database, service } = createService();
  try {
    const form = createNewProjectForm(service);

    assert.equal(form.schema.title, '新建项目');
    assert.deepEqual(form.schema.fields.map((field) => field.key), [
      'name',
      'description',
      'visualStyle',
      'defaultAspectRatio',
      'defaultResolution'
    ]);
    assert.equal(form.schema.fields[0].required, true);
    assert.equal(form.schema.fields[0].checkUnique, true);
    assert.deepEqual(form.initialValues, {});
  } finally {
    database.close();
  }
});

test('新建表单：提交后创建项目，重名提交被拒绝', () => {
  const { database, service } = createService();
  try {
    const form = createNewProjectForm(service);
    form.submit({ name: '灯塔计划', description: '', visualStyle: '', defaultAspectRatio: '16:9', defaultResolution: '' });

    assert.equal(service.listProjects().length, 1);
    assert.equal(service.listProjects()[0].defaultAspectRatio, '16:9');
    assert.throws(() => form.submit({ name: '灯塔计划' }), ConflictError);
    assert.throws(() => form.submit({ name: '' }), ValidationError);
  } finally {
    database.close();
  }
});

test('新建表单：名称检查在重名时返回提示，其他字段不检查', () => {
  const { database, service } = createService();
  try {
    service.createProject({ name: '已有项目' });
    const form = createNewProjectForm(service);

    assert.match(form.checkField?.('name', '已有项目') ?? '', /同名项目/);
    assert.equal(form.checkField?.('name', '新项目'), undefined);
    assert.equal(form.checkField?.('description', '已有项目'), undefined);
  } finally {
    database.close();
  }
});

test('编辑表单：初始值来自项目，未设置的选项为空串', () => {
  const { database, service } = createService();
  try {
    const project = service.createProject({ name: '灯塔计划', description: '描述', visualStyle: '水彩插画' });
    const form = createEditProjectForm(service, project);

    assert.equal(form.schema.title, '编辑项目');
    assert.deepEqual(form.initialValues, {
      name: '灯塔计划',
      description: '描述',
      visualStyle: '水彩插画',
      defaultAspectRatio: '',
      defaultResolution: ''
    });
  } finally {
    database.close();
  }
});

test('编辑表单：已保存的默认画幅与分辨率原样带入初始值', () => {
  const { database, service } = createService();
  try {
    const project = service.createProject({ name: '灯塔计划', defaultAspectRatio: '9:16', defaultResolution: '480P' });
    const form = createEditProjectForm(service, project);

    assert.equal(form.initialValues.defaultAspectRatio, '9:16');
    assert.equal(form.initialValues.defaultResolution, '480P');
  } finally {
    database.close();
  }
});

test('编辑表单：保留自身名称可提交，与其他项目重名被拒绝，检查时排除自身', () => {
  const { database, service } = createService();
  try {
    const first = service.createProject({ name: '甲' });
    service.createProject({ name: '乙' });
    const form = createEditProjectForm(service, first);

    assert.equal(form.checkField?.('name', '甲'), undefined);
    assert.match(form.checkField?.('name', '乙') ?? '', /同名项目/);
    form.submit({ name: '甲', description: '新描述' });
    assert.equal(service.getProject(first.id).description, '新描述');
    assert.throws(() => form.submit({ name: '乙' }), ConflictError);
  } finally {
    database.close();
  }
});

test('表单目录：按名称创建新建与编辑表单，编辑需要有效的项目标识', () => {
  const { database, service } = createService();
  try {
    const project = service.createProject({ name: '甲' });
    const catalog = createProjectFormCatalog(service);

    assert.equal(catalog.get(PROJECT_FORM_NAMES.create)?.(undefined).schema.title, '新建项目');
    const edit = catalog.get(PROJECT_FORM_NAMES.edit);
    assert.equal(edit?.({ id: project.id }).initialValues.name, '甲');
    assert.throws(() => edit?.({ id: '1' }), ValidationError);
    assert.throws(() => edit?.({ id: 99 }), NotFoundError);
  } finally {
    database.close();
  }
});
