const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenAccessFilter } = require('./auth')
const CsvStringify = require('csv-stringify')
const Archiver = require('archiver')
const { PassThrough } = require('stream')
const { getBillingDetail } = require('./billing')
const mime = require('mime')

// catch null, and rename jpeg to jpg
const getExtension = (...arg) => (mime.getExtension(...arg) || '').replace('jpeg', 'jpg')

const escapeCsvLiteral = (str) => {
    let ret = String(str || '')
    const containsNewline = ret.indexOf('\n') >= 0 || ret.indexOf('\r') >= 0 || ret.indexOf('\n\r') >= 0
    const needQuote = ret.indexOf(',') >= 0 || containsNewline
    const containsQuote = ret.indexOf('"') >= 0

    if (needQuote && containsQuote) {
        ret = ret.replace(/"/g, '""')
        ret = `"${ret}"`
    }
    if (needQuote && !containsQuote) {
        ret = ret.replace(/"/g, '""')
    }

    return ret
}

const getRawValue = (obj, key) => {
    let keys = key.split('.')
    let cur = obj
    for (let key of keys) {
        if (cur && cur[key]) {
          cur = cur[key]
        } else {
          return ''
        }
    }
    return cur
}

const GV = (obj, key) => escapeCsvLiteral(getRawValue(obj, key) || '')

const GNV = (obj, key) => getRawValue(obj, key) || 0

const isLeaderText = val => val ? '领队' : ''

const withdrawText = val => val ? '退会' : ''

const genderText = val => {
    switch (val) {
        case 'm': return '男'
        case 'f': return '女'
        case 'x': return '其它'
        default:  return ''
    }
}

const applicationTypeText = val => {
    switch (val) {
        case 'school': return '学校'
        case 'individual': return '个人'
        default:  return ''
    }
}

const idTypeText = val => {
    switch (val) {
        case 'mainland': return '中国大陆身份证'
        case 'sar':      return '港澳'
        case 'taiwan':   return '台胞证'
        case 'passport': return '护照'
        case 'other':    return '其它'
        default:         return ''
    }
}

const guardianTypeText = val => {
    switch(val) {
        case 'father': return '父'
        case 'mother': return '母'
        case 'other':  return '其他'
    }
}

const roomshareState = val => {
    const roomshareStateText = val => {
        switch (val) {
            case 'pending': return '待确认'
            case 'accepted': return '已确认'
            case 'rejected': return '已拒绝'
            case 'peer-withdraw': return '对方学校已退会'
        }
    }
    if (val.roomshare) {
        const roomshareSchoolName = val.roomshareSchool[0] ? val.roomshareSchool[0].identifier : ''
        const roomshareConclusion = val.roomshare.state === 'accepted' ? '是' : ''
        return [roomshareConclusion, roomshareSchoolName, roomshareStateText(val.roomshare.state)]
    } else {
        return ['', '', '']
    }
}

const provinceCityText = val => {
    return Array.isArray(val) ? val.join(' / ') : ''
}

const paymentMethodText = val => {
    switch (val) {
        case 'cash': return '现金'
        case 'bank': return '银行转账'
        case 'alipay': return '支付宝'
        default: return ''
    }
}

const reimbursementStateText = val => {
    switch (val) {
        case 'submitted': return '待审核'
        case 'approved': return '已通过'
        case 'rejected': return '未通过'
        case 'completed': return '已完成'
        default: return '未提交'
    }
}

const disclaimerApprovalText = val => {
    if (val === true) return '通过'
    if (val === false) return '未通过'
    return '待审核'
}

const schoolRoundText = val => {
    if (val === '1') return '一轮'
    return '追加'
}

const billRuleText = val => {
    switch (val) {
        case 'earlybird': return '早鸟'
        case 'ordinary': return '常规'
        default: return '未知'
    }
}

const REPRESENTATIVE = {
    columns: [
        '领队标记',
        '退会标记',
        '权责声明',
        '学校',
        '会场',
        '姓名',
        '性别',
        '手机',
        'QQ',
        '邮箱',
        '毕业时间',
        '证件类型',
        '证件号码',
        '第一监护人关系',
        '第一监护人姓名',
        '第一监护人手机',
        '第一监护人证件类型',
        '第一监护人证件号码',
        '第二监护人关系',
        '第二监护人姓名',
        '第二监护人手机',
        '备注',
        '席位'
    ],
    map: $ => [
       isLeaderText( GV($, 'is_leader') ),
       withdrawText( GV($, 'withdraw') ),
       disclaimerApprovalText( GV($, 'disclaimer_approval') ),
       GV($, 'school.identifier'),
       GV($, 'session.name'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.qq'),
       GV($, 'contact.email'),
       GV($, 'graduation_year'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       guardianTypeText( GV($, 'alt_guardian.type') ),
       GV($, 'alt_guardian.name'),
       GV($, 'alt_guardian.phone'),
       GV($, 'comment'),
       GV($, 'note')
    ]
}

const flattenArray = (a, b) => [...a, ...b]

const BILLING = {
    columns: [ '学校', '阶段', '缴费规则', '类别', '项目', '数量/天数', '单价', '总价' ],
    map: $ => [
        GV($, 'identifier'),
        schoolRoundText( GV($, 'round') ),
        billRuleText( GV($, 'effectiveRule') ),
        GV($, 'type'),
        GV($, 'name'),
        GV($, 'amount'),
        GNV($, 'price'),
        GNV($, 'sum'),
    ]
}

const RESERVATION = {
    columns: [
        '学校',
        '酒店',
        '房型',
        '入住日期',
        '退房日期',
        '拼房',
        '拼房学校',
        '拼房状态'
    ],
    map: $ => [
        GV($, 'school.identifier'),
        GV($, 'hotel.name'),
        GV($, 'hotel.type'),
        GV($, 'checkIn'),
        GV($, 'checkOut'),
        ... roomshareState($)
    ]
}

const COMMITTEE = {
    columns: [
        '职能',
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        'QQ',
        '证件类型',
        '证件号码',
        '紧急联系人关系',
        '紧急联系人姓名',
        '紧急联系人手机',
        '紧急联系人证件类型',
        '紧急联系人证件号码',
        '来宁日期',
        '离宁日期',
        '酒店入住日期',
        '酒店退房日期',
        '备注'
    ],
    map: $ => [
       GV($, 'role'),
       GV($, 'school'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'contact.qq'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'arriveDate'),
       GV($, 'departDate'),
       GV($, 'checkInDate'),
       GV($, 'checkOutDate'),
       GV($, 'comment')
    ]
}

const VOLUNTEER = {
    columns: [
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        'QQ',
        '证件类型',
        '证件号码',
        '紧急联系人关系',
        '紧急联系人姓名',
        '紧急联系人手机',
        '紧急联系人证件类型',
        '紧急联系人证件号码',
        '来宁日期',
        '离宁日期',
        '酒店入住日期',
        '酒店退房日期',
        '备注'
    ],
    map: $ => [
       GV($, 'school'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'contact.qq'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'arriveDate'),
       GV($, 'departDate'),
       GV($, 'checkInDate'),
       GV($, 'checkOutDate'),
       GV($, 'comment')
    ]
}

const DAIS = {
    columns: [
        '职能',
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        'QQ',
        '证件类型',
        '证件号码',
        '紧急联系人关系',
        '紧急联系人姓名',
        '紧急联系人手机',
        '紧急联系人证件类型',
        '紧急联系人证件号码',
        '来宁日期',
        '离宁日期',
        '酒店入住日期',
        '酒店退房日期',
        '备注'
    ],
    map: $ => [
       GV($, 'role'),
       GV($, 'school'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'contact.qq'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'arriveDate'),
       GV($, 'departDate'),
       GV($, 'checkInDate'),
       GV($, 'checkOutDate'),
       GV($, 'comment')
    ]
}

const APPLICATION_CONTACT = {
    columns: [
        '类型',
        '学校',
        '所在地',
        '联系人1',
        '性别2',
        '手机2',
        '邮箱2',
        '联系人2',
        '性别2',
        '手机2',
        '邮箱2',
    ],
    map: $ => [
       applicationTypeText(GV($, 'type')),
       GV($, 'school.name'),
       GV($, 'school.administrative_area'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'alt_contact.name') || GV($, 'guardian.name'),
       guardianTypeText( GV($, 'alt_contact.gender') ) || GV($, 'guardian.type'),
       GV($, 'alt_contact.phone') || GV($, 'guardian.phone'),
       GV($, 'alt_contact.email')
    ]
}

const DAIS_REIMBURSEMENT = {
    columns: [
        '主席姓名',
        '学校所在地',
        '家庭居住地',
        '出发地',
        '目的地',
        '来程路费',
        '回程路费',
        '报销方式',
        '银行-卡号',
        '银行-开户行',
        '银行-开户人',
        '支付宝-账号',
        '支付宝-姓名',
        '来程报销状态',
        '回程报销状态',
    ],
    map: $ => [
        GV($, 'contact.name'),
        provinceCityText( GV($, 'reimbursement.school_region') ),
        provinceCityText( GV($, 'reimbursement.residence_region') ),
        provinceCityText( GV($, 'reimbursement.inbound.region') ),
        provinceCityText( GV($, 'reimbursement.outbound.region') ),
        Number(GNV($, 'reimbursement.inbound.cost')).toFixed(2),
        Number(GNV($, 'reimbursement.outbound.cost')).toFixed(2),
        paymentMethodText( GV($, 'reimbursement.payment_method') ),
        GV($, 'reimbursement.bank.account'),
        GV($, 'reimbursement.bank.branch'),
        GV($, 'reimbursement.bank.name'),
        GV($, 'reimbursement.alipay.account'),
        GV($, 'reimbursement.alipay.name'),
        reimbursementStateText( GV($, 'reimbursement.inbound.state') ),
        reimbursementStateText( GV($, 'reimbursement.outbound.state') ),
    ]
}

const FOREIGNER = {
    columns: [
        '报名渠道',
        '姓',
        '名',
        '性别',
        '国籍',
        '护照号码',
        '出生日期',
        '学校',
        '邮箱',
        '电话',
        '紧急联系人电话',
        '会场',
        '以往参会经历',
        '饮食需求',
        '健康状况说明',
        '备注',
    ],
    map: $ => [
       GV($, 'referrer'),
       GV($, 'last_name'),
       GV($, 'first_name'),
       genderText( GV($, 'gender') ),
       GV($, 'nationality'),
       GV($, 'passport_number'),
       GV($, 'birthday'),
       GV($, 'school'),
       GV($, 'email'),
       GV($, 'phone'),
       GV($, 'emergency_contact_phone'),
       GV($, 'request_session'),
       GV($, 'past_mun_experience'),
       GV($, 'dietary_requirement'),
       GV($, 'health_condition'),
       GV($, 'comment')
    ]
}

const createCsvStream = (cursor, columns, map, flatten = false) => {
    const stream = new CsvStringify()
    stream.write(columns)
    setImmediate(async () => {
        try {
            while (await cursor.hasNext()) {
                const mapped = await map(await cursor.next())
                if (flatten)
                    mapped.forEach($ => stream.write($))
                else
                    stream.write(mapped)
            }
        } catch(e) {
            stream.write(['ERROR', e.message])
        } finally {
            stream.end()
        }
    })
    return stream
}

const AGGREGATE_OPTS = {
    collation: {
        locale: 'zh'
    }
}

const LOOKUP_SCHOOL_BILLING = [
    { $match: {active: false} },
    { $lookup: {from: 'school', localField: 'school', foreignField: '_id', as: 'school'} },
    { $unwind: '$school' },
    { $unwind: '$confirmedBills' },
    { $project: {
        identifier: '$school.identifier',
        round: '$confirmedBills.round',
        effectiveRule: '$effectiveRule',
        type: '$confirmedBills.type',
        name: '$confirmedBills.name',
        amount: '$confirmedBills.amount',
        price: '$confirmedBills.effectivePrice',
        sum: '$confirmedBills.effectiveSum',
    } },
    { $sort: {
        identifier: 1,
        round: 1,
        type: 1,
    } }
]

const LOOKUP_REPRESENTATIVE = [
    { $lookup: {
        localField: 'school',
        foreignField: '_id',
        from: 'school',
        as: 'school',
    } },
    { $lookup: {
        localField: 'session',
        foreignField: '_id',
        from: 'session',
        as: 'session',
    } },
    { $unwind: '$school' },
    { $unwind: '$session' },
    { $sort: { 'school.type': 1, 'school.identifier': 1 } },
]

const LOOKUP_LEADER = [
    { $match: { 'is_leader': true } },
    ... LOOKUP_REPRESENTATIVE
]

const LOOKUP_RESERVATION = [
    { $lookup: {
        from: 'hotel',
        localField: 'hotel',
        foreignField: '_id',
        as: 'hotel'
    }},
    { $lookup: {
        from: 'school',
        localField: 'school',
        foreignField: '_id',
        as: 'school'
    } },
    { $lookup: {
        from: 'school',
        localField: 'roomshare.school',
        foreignField: '_id',
        as: 'roomshareSchool'
    } },
    { $unwind: '$hotel' },
    { $unwind: '$school' },
    { $sort: { 'school.type': 1, 'school.identifier': 1 } },
]

const LOOKUP_COMMITTEE = [
    { $sort: { role: 1, 'contact.name': 1 } }
]

const LOOKUP_VOLUNTEER = [
    { $sort: { 'contact.name': 1 } }
]

const LOOKUP_DAIS = [
    { $sort: { role: 1, 'contact.name': 1 } }
]

const LOOKUP_SCHOOL_SEAT = [
    { $sort: { 'identifier': 1 } },
    { $project: {
        name: '$identifier',
        r1: '$seat.1',
        r2: {$ifNull: ['$seat.2', {}]}
    }}
]

const LOOKUP_APPLICATION_SEAT = [
    { $sort: { 'identifier': 1 } },
    { $project: {
        name: '$identifier',
        seat: '$seat'
    }}
]

const LOOKUP_APPLICATION_CONTACT = [
    { $sort: { 'school.name': 1 } },
    { $project: {
        school: '$school',
        contact: '$contact',
        alt_contact: '$alt_contact',
        guardian: '$guardian'
    }}
]

const LOOKUP_DAIS_REIMBURSEMENT = [
    { $sort: { 'contact.name': 1 } }
]

const LOOKUP_FOREIGNER_APPLICATION = [
    { $sort: { 'created': 1 } },
    { $lookup: {
        localField: 'request_session',
        foreignField: '_id',
        from: 'session',
        as: 'session',
    } },
    { $unwind: '$session' },
]

route.get('/export/representatives',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate(LOOKUP_REPRESENTATIVE, AGGREGATE_OPTS),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/leaders',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate(LOOKUP_LEADER, AGGREGATE_OPTS),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/billings',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        // compute billing details for every school on export
        ctx.body = createCsvStream(
            ctx.db.collection('payment').aggregate(LOOKUP_SCHOOL_BILLING, AGGREGATE_OPTS),
            BILLING.columns,
            BILLING.map
        )
    }
)

route.get('/export/reservations',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('reservation').aggregate(LOOKUP_RESERVATION, AGGREGATE_OPTS),
            RESERVATION.columns,
            RESERVATION.map
        )
    }
)

route.get('/export/committees',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('committee').aggregate(LOOKUP_COMMITTEE, AGGREGATE_OPTS),
            COMMITTEE.columns,
            COMMITTEE.map
        )
    }
)

route.get('/export/volunteers',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('volunteer').aggregate(LOOKUP_VOLUNTEER, AGGREGATE_OPTS),
            VOLUNTEER.columns,
            VOLUNTEER.map
        )
    }
)

route.get('/export/daises',
    TokenAccessFilter(AccessFilter('finance', 'admin', 'academic-director')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('dais').aggregate(LOOKUP_DAIS, AGGREGATE_OPTS),
            DAIS.columns,
            DAIS.map
        )
    }
)

route.get('/export/seats',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        const sessions = await ctx.db.collection('session')
            .find({ reserved: { $ne: true } })
            .map(({_id, name}) => ({ id: _id, name }))
            .toArray()
        const columns = ['学校', ...sessions.map($ => $.name)]
        const columnMapper = $ => [
            GV($, 'name'),
            ...sessions.map(({id}) => GNV($, `r1.${id}`) + GNV($, `r2.${id}`))
        ]
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('school').aggregate(LOOKUP_SCHOOL_SEAT, AGGREGATE_OPTS),
            columns,
            columnMapper
        )
    }
)

route.get('/export/applications/seats',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        const sessions = await ctx.db.collection('session')
            .find({ reserved: { $ne: true } })
            .map(({_id, name}) => ({ id: _id, name }))
            .toArray()
        const columns = ['学校', ...sessions.map($ => $.name)]
        const columnMapper = $ => [
            GV($, 'name'),
            ...sessions.map(({id}) => GNV($, `seat.${id}`))
        ]
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('application').aggregate(LOOKUP_APPLICATION_SEAT, AGGREGATE_OPTS),
            columns,
            columnMapper
        )
    }
)

route.get('/export/applications/contacts',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('application').aggregate(LOOKUP_APPLICATION_CONTACT, AGGREGATE_OPTS),
            APPLICATION_CONTACT.columns,
            APPLICATION_CONTACT.map
        )
    }
)

route.get('/export/foreigner-applications',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('foreigner').aggregate(LOOKUP_FOREIGNER_APPLICATION, AGGREGATE_OPTS),
            FOREIGNER.columns,
            FOREIGNER.map
        )
    }
)

const NameCreator = () => {
    let map = {}
    return (name) => {
        if (map[name]) {
            map[name] += 1
        } else {
            map[name] = 1
        }
        if (map[name] > 1)
            return name + '-' + map[name]
        else
            return name
    }
}

const addExtensionFromMime = (name, mime) => {
    return `${name}.${getExtension(mime)}`
}

// `generateFn` is provided with the following object to
// maintain backpressure:
//
// {
//    shouldStop(): returns whether the stream is ended
//       (e.g. when client connection is lost). generateFn
//       should exit after this returns true.
//
//    append(): same as archiver's append(), except it
//       returns after the entry has been processed
//
//    finalize(): same as archiver's finalize()
// }
function streamZipArchive(generateFn) {
    const archiver = Archiver('zip', {store: true})
    const outStream = archiver.pipe(new PassThrough())

    // Defer the following execution after we return, so Koa can start
    // streaming the response instead of holding it in memory
    ;(async function() {
        let streamEnded = false
        outStream.once('close', () => streamEnded = true)

        generateFn({
            shouldStop() { return streamEnded },
            append(...args) {
                archiver.append(...args)
                return new Promise(resolve => archiver.once('entry', resolve))
            },
            finalize() { return archiver.finalize() }
        })
    })()

    return outStream
}

const appendDbImageToZipStream = async (zipStream, db, imageId, name) => {
    const image = await db.collection('image').findOne({ _id: imageId })

    if (!image)
        return

    return zipStream.append(
        image.buffer.buffer,
        { name: addExtensionFromMime(name, image.mime), date: image.created }
    )
}

route.get('/export/committees/photos',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'application/zip;charset=utf-8')
        ctx.body = streamZipArchive(async (zipStream) => {
            const committees = await ctx.db.collection('committee').aggregate(LOOKUP_COMMITTEE).toArray()
            const createName = NameCreator()
            for (let committee of committees) {
                if (zipStream.shouldStop())
                    break

                const name = createName(GV(committee, 'role') + '-' + GV(committee, 'contact.name'))
                await appendDbImageToZipStream(zipStream, ctx.db, committee.photoId, name)
            }
            zipStream.finalize()
        })
    }
)

route.get('/export/daises/photos',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'application/zip;charset=utf-8')
        ctx.body = streamZipArchive(async (zipStream) => {
            const daises = await ctx.db.collection('dais').aggregate(LOOKUP_DAIS).toArray()
            const createName = NameCreator()
            for (let dais of daises) {
                if (zipStream.shouldStop())
                    break

                const name = createName(GV(dais, 'role') + '-' + GV(dais, 'contact.name'))
                await appendDbImageToZipStream(zipStream, ctx.db, dais.photoId, name)
            }
            zipStream.finalize()
        })
    }
)

route.get('/export/representatives/photos',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'application/zip;charset=utf-8')
        ctx.body = streamZipArchive(async (zipStream) => {
            const representatives = await ctx.db.collection('representative').aggregate(LOOKUP_REPRESENTATIVE, AGGREGATE_OPTS).toArray()
            const createName = NameCreator()
            for (let representative of representatives) {
                if (zipStream.shouldStop())
                    break

                const name = createName(GV(representative, 'school.school.name') + '-' + GV(representative, 'contact.name') + '-' + GV(representative, 'identification.number'))
                await appendDbImageToZipStream(zipStream, ctx.db, representative.avatar_image, name)
            }
            zipStream.finalize()
        })
    }
)

route.get('/export/representatives/disclaimers',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'application/zip;charset=utf-8')
        ctx.body = streamZipArchive(async (zipStream) => {
            const representatives = await ctx.db.collection('representative')
                .aggregate(LOOKUP_REPRESENTATIVE, AGGREGATE_OPTS)
                .toArray()
            const createName = NameCreator()

            for (let representative of representatives) {
                if (zipStream.shouldStop())
                    break

                const name = createName(
                    GV(representative, 'school.school.name') + '-'
                    + (GV(representative, 'contact.name') || GV(representative, '_id')) + '-'
                    + GV(representative, 'identification.number')
                )

                await appendDbImageToZipStream(zipStream, ctx.db, representative.disclaimer_image, name)
            }

            zipStream.finalize()
        })
    }
)

route.get('/export/daises/reimbursements',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('dais').aggregate(LOOKUP_DAIS_REIMBURSEMENT, AGGREGATE_OPTS),
            DAIS_REIMBURSEMENT.columns,
            DAIS_REIMBURSEMENT.map
        )
    }
)

route.get('/export/daises/reimbursement-credentials',
    TokenAccessFilter(AccessFilter('finance', 'admin')),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'application/zip;charset=utf-8')
        ctx.body = streamZipArchive(async (zipStream) => {
            const STATES_TO_EXPORT = ['approved', 'completed']
            const daises = await ctx.db.collection('dais').aggregate(LOOKUP_DAIS_REIMBURSEMENT, AGGREGATE_OPTS).toArray()
            const createName = NameCreator()
            for (let dais of daises) {
                const inboundState = GV(dais, 'reimbursement.inbound.state')
                if (STATES_TO_EXPORT.includes(inboundState)) {
                    const inboundCreds = GV(dais, 'reimbursement.inbound.credential') || []
                    const name = createName(GV(dais, 'contact.name') + '-来程')
                    for (let photoId of inboundCreds)
                        await appendDbImageToZipStream(zipStream, ctx.db, photoId, name)
                }
                const outboundState = GV(dais, 'reimbursement.outbound.state')
                if (STATES_TO_EXPORT.includes(outboundState)) {
                    const outboundCreds = GV(dais, 'reimbursement.outbound.credential') || []
                    const name = createName(GV(dais, 'contact.name') + '-回程')
                    for (let photoId of outboundCreds)
                        await appendDbImageToZipStream(zipStream, ctx.db, photoId, name)
                }
            }
            zipStream.finalize()
        })
    }
)

module.exports = {
    routes: route.routes()
}
